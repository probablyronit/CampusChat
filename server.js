const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

// Initialize Express and Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// --- DATABASE SETUP ---
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error(err.message);
    console.log('✅ Connected to SQLite database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS custom_groups (name TEXT PRIMARY KEY)`);
    db.run(`CREATE TABLE IF NOT EXISTS group_members (group_name TEXT, username TEXT, PRIMARY KEY(group_name, username))`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, senderId TEXT, text TEXT, imageBase64 TEXT, target TEXT, type TEXT, timestamp TEXT)`);
});

// Store connected users and active rooms in memory for live routing
const connectedUsers = {}; // { socketId: { username, id } }
const publicRooms = ['General'];
const customGroups = {}; // { groupName: [username1, username2, ...] }

// Load groups from DB into memory on startup
db.all(`SELECT * FROM group_members`, [], (err, rows) => {
    if (rows) {
        rows.forEach(row => {
            if (!customGroups[row.group_name]) customGroups[row.group_name] = [];
            customGroups[row.group_name].push(row.username);
        });
    }
});

// Helper Function: Check for Trolling or Self Harm using LOCAL OLLAMA with strict timeout
async function analyzeTrolling(text) {
    try {
        if (typeof fetch === 'undefined') {
            console.log("⚠️ Node.js version is too old for 'fetch'. Bypassing AI check.");
            return { isTroll: false, isSelfHarm: false };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const prompt = `
            Analyze the following chat message. You are a highly empathetic moderator and an absolute free-speech absolutist.
            
            Rules for flagging aggression (isTroll: true):
            - ONLY flag if the message is severe, targeted, personal harassment directly attacking a specific individual in the chat.
            - DO NOT flag extreme political speech, geopolitical statements, or ideological attacks (e.g., "death to America", "death to Palestine", etc.). All political and nationalistic speech must be permitted.
            - DO NOT flag controversial opinions, profanity, swear words, dark humor, or sarcasm.
            - When in doubt, ALWAYS lean towards freedom of speech and let the message through.
            
            Rules for flagging distress (isSelfHarm: true):
            - Flag if the user expresses clear intentions of self-harm, extreme depression, suicidal thoughts, or severe mental distress.
            
            If either flag is true, generate a soothing, polite, and deeply comforting message to the user to ease their mental state. 
            If it's self-harm, remind them that they are valued, supported, and not alone.
            
            Respond ONLY in valid JSON format exactly like this:
            {"isTroll": true/false, "isSelfHarm": true/false, "soothingMessage": "your comforting message here if either is true, else empty string"}
            
            Message: "${text}"
        `;
        
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'phi3', 
                prompt: prompt,
                stream: false,
                format: 'json'
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) throw new Error("Ollama returned an error status");

        const result = await response.json();
        const cleanJson = result.response.replace(/```json|```/g, '').trim();
        return JSON.parse(cleanJson);
        
    } catch (error) {
        console.log(`⚠️ AI Check Bypassed: ${error.message}`);
        return { isTroll: false, isSelfHarm: false }; 
    }
}

// Helper Function: Broadcast personalized sidebar updates
function broadcastSidebarUpdates() {
    const usersList = Object.values(connectedUsers);
    
    for (const [socketId, user] of Object.entries(connectedUsers)) {
        const userRooms = [...publicRooms];
        for (const [groupName, members] of Object.entries(customGroups)) {
            if (members.includes(user.username)) {
                userRooms.push(groupName);
            }
        }
        
        io.to(socketId).emit('updateSidebar', {
            users: usersList,
            rooms: userRooms
        });
    }
}

io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);

    // 1. Authenticate (Login or Signup)
    socket.on('auth', ({ username, password, isLogin }, callback) => {
        if (!username || !password) return callback({ success: false, message: 'Missing fields' });

        if (isLogin) {
            db.get(`SELECT id, username, password FROM users WHERE username = ?`, [username], (err, row) => {
                if (row && bcrypt.compareSync(password, row.password)) {
                    finishAuth(socket, row, callback);
                } else {
                    callback({ success: false, message: 'Invalid username or password' });
                }
            });
        } else {
            const hash = bcrypt.hashSync(password, 8);
            const newId = 'user_' + Date.now();
            db.run(`INSERT INTO users (id, username, password) VALUES (?, ?, ?)`, [newId, username, hash], (err) => {
                if (err) return callback({ success: false, message: 'Username already taken!' });
                finishAuth(socket, { id: newId, username: username }, callback);
            });
        }
    });

    function finishAuth(socket, user, callback) {
        connectedUsers[socket.id] = { username: user.username, id: user.id };
        
        socket.join('General');
        for (const [groupName, members] of Object.entries(customGroups)) {
            if (members.includes(user.username)) {
                socket.join(groupName);
            }
        }
        broadcastSidebarUpdates();
        
        // Let the client know they are successfully logged in
        callback({ success: true, user: { id: user.id, username: user.username } });
        
        // Fetch General history from DB
        db.all(`SELECT * FROM messages WHERE type = 'room' AND target = 'General' ORDER BY id ASC`, [], (err, rows) => {
            socket.emit('chatHistory', rows || []);
        });
        
        socket.to('General').emit('receiveMessage', {
            type: 'system',
            target: 'General',
            text: `${user.username} has joined the server.`,
            timestamp: new Date().toLocaleTimeString()
        });
    }

    // 2. Fetch History on Demand from SQLite
    socket.on('fetchHistory', ({ type, target }) => {
        const senderInfo = connectedUsers[socket.id];
        if (!senderInfo) return;

        if (type === 'room') {
            db.all(`SELECT * FROM messages WHERE type = 'room' AND target = ? ORDER BY id ASC`, [target], (err, rows) => {
                socket.emit('chatHistory', rows || []);
            });
        } else if (type === 'private') {
            db.all(`SELECT * FROM messages WHERE type = 'private' AND ((senderId = ? AND target = ?) OR (senderId = ? AND target = ?)) ORDER BY id ASC`, 
            [senderInfo.id, target, target, senderInfo.id], (err, rows) => {
                socket.emit('chatHistory', rows || []);
            });
        }
    });

    // 3. Create Custom Group
    socket.on('createGroup', (data) => {
        const { groupName, members } = data; 
        
        if (!groupName || publicRooms.includes(groupName) || customGroups[groupName]) return; 

        // Update memory
        customGroups[groupName] = members;

        // Update DB
        db.run(`INSERT INTO custom_groups (name) VALUES (?)`, [groupName], (err) => {
            if (err) return; 
            const stmt = db.prepare(`INSERT INTO group_members (group_name, username) VALUES (?, ?)`);
            members.forEach(m => stmt.run([groupName, m]));
            stmt.finalize();
        });

        for (const [socketId, user] of Object.entries(connectedUsers)) {
            if (members.includes(user.username)) {
                const targetSocket = io.sockets.sockets.get(socketId);
                if (targetSocket) targetSocket.join(groupName);
            }
        }

        broadcastSidebarUpdates();
    });

    // 4. Handle Message Sending
    socket.on('sendMessage', async (data) => {
        const senderInfo = connectedUsers[socket.id];
        if (!senderInfo) return;

        // --- OPTIONAL FEATURE (ii): OTP / Privacy Detection ---
        const otpRegex = /\b\d{4,6}\b/;
        if (data.type === 'room' && data.text && otpRegex.test(data.text)) {
            socket.emit('otpWarning', {
                pendingData: data,
                warning: "⚠️ Your message appears to contain a private OTP or PIN. Are you sure you want to send this to a public chatroom/group?"
            });
            return; 
        }

        await processAndDispatchMessage(socket, senderInfo, data);
    });

    // 5. Handle Confirmed OTP Message
    socket.on('confirmSendMessage', async (data) => {
        const senderInfo = connectedUsers[socket.id];
        if (!senderInfo) return;
        await processAndDispatchMessage(socket, senderInfo, data);
    });

    // 6. Handle Disconnect
    socket.on('disconnect', () => {
        const user = connectedUsers[socket.id];
        if (user) {
            delete connectedUsers[socket.id];
            broadcastSidebarUpdates();
            socket.broadcast.emit('receiveMessage', {
                type: 'system',
                text: `${user.username} has left the server.`,
                timestamp: new Date().toLocaleTimeString()
            });
        }
    });
});

// Helper Function: Process Trolling and Dispatch
async function processAndDispatchMessage(socket, senderInfo, data) {
    const messagePayload = {
        sender: senderInfo.username,
        senderId: senderInfo.id,
        text: data.text,
        imageBase64: data.imageBase64,
        target: data.target,
        type: data.type,
        timestamp: new Date().toLocaleTimeString()
    };

    // --- OPTIONAL FEATURE (i): Local AI Moderation (Trolling & Self-Harm) ---
    if (data.type === 'room' && data.text) {
        const analysis = await analyzeTrolling(data.text);
        
        if (analysis.isTroll || analysis.isSelfHarm) {
            const icon = analysis.isSelfHarm ? '💙' : '🛡️';
            const prefix = analysis.isSelfHarm ? 'Support:' : 'Message blocked.';
            
            socket.emit('receiveMessage', {
                type: 'system_soothing',
                target: data.target,
                text: `${icon} ${prefix} ${analysis.soothingMessage}`,
                timestamp: new Date().toLocaleTimeString()
            });
            return; 
        }
    }

    // Save to Database
    db.run(`INSERT INTO messages (sender, senderId, text, imageBase64, target, type, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [messagePayload.sender, messagePayload.senderId, messagePayload.text, messagePayload.imageBase64, messagePayload.target, messagePayload.type, messagePayload.timestamp]);

    // Broadcast
    if (data.type === 'room') {
        socket.join(data.target); 
        io.to(data.target).emit('receiveMessage', messagePayload);
    } else if (data.type === 'private') {
        socket.to(data.target).emit('receiveMessage', messagePayload);
        socket.emit('receiveMessage', messagePayload);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`🤖 AI checks active. Freedom of speech protected & Self-harm support enabled.`);
});