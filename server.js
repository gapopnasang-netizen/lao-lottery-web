const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// ตั้งค่าให้เปิดหน้า login.html เป็นหน้าแรกเมื่อเข้าเว็บ
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client', 'login.html'));
});

// API Login สำหรับตรวจสอบสิทธิ์
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'member01' && password === '123456') {
        res.json({ success: true, role: 'member', username, credit: 5000 });
    } else if (username === 'agent_boss' && password === '123456') {
        res.json({ success: true, role: 'agent', username, credit: 100000 });
    } else {
        res.status(401).json({ success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
});

// Socket.io Real-time สำหรับส่งโพย
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('submit_bet', (orderData) => {
        io.emit('broadcast_new_order', orderData);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});