const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

// เก็บข้อมูลโพยหวยและผลรางวัลในหน่วยความจำชั่วคราว
let allOrders = [];
let latestResult = { threeTop: '---', twoBottom: '--' };

// หน้าแรก
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

// API Login
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

// Socket.io จัดการโพยและการออกรางวัล
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // ส่งประวัติโพยเดิมและผลรางวัลล่าสุดให้ผู้ใช้ใหม่ที่เพิ่งเชื่อมต่อ
    socket.emit('init_data', { orders: allOrders, result: latestResult });

    // รับโพยจากสมาชิก
    socket.on('submit_bet', (orderData) => {
        orderData.id = Date.now();
        orderData.status = 'รอผลรางวัล';
        allOrders.unshift(orderData); // เก็บไว้ด้านบนสุด

        // Broadcast ให้ Agent และทุกคนเห็นโพยสดๆ
        io.emit('broadcast_new_order', orderData);
    });

    // แอดมิน/เอเยนต์กดออกผลรางวัล
    socket.on('publish_result', (resultData) => {
        latestResult = resultData;

        // วนลูปตรวจโพยว่าใครถูกรางวัลบ้าง (ตัวอย่างเทียบเลข 2 ตัวท้าย)
        allOrders.forEach(order => {
            if (order.number.slice(-2) === resultData.twoBottom) {
                order.status = 'ถูกรางวัล 🎉';
            } else {
                order.status = 'ไม่ถูกรางวัล ❌';
            }
        });

        // ส่งผลรางวัลและสถานะอัปเดตไปให้ทุกคน
        io.emit('update_result_and_orders', { result: latestResult, orders: allOrders });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});