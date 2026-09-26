const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// MongoDB Connection
mongoose.connect('mongodb://localhost:27017/laolottery', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('🔥 MongoDB Connected - Advanced Lottery System Active');
}).catch(err => {
    console.log('⚠️ Running in offline/memory mode.');
});

// Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    credit: { type: Number, default: 0 },
    role: { type: String, default: 'member' } // member, agent
});
const User = mongoose.model('User', userSchema);

const orderSchema = new mongoose.Schema({
    username: String,
    type: String, // 3บน, 2ล่าง, 19ประตู, 6กลับ, etc.
    number: String,
    amount: Number,
    discount: Number,
    netPay: Number,
    time: String,
    status: { type: String, default: 'รอผลรางวัล' }
});
const Order = mongoose.model('Order', orderSchema);

const settingsSchema = new mongoose.Schema({
    key: String,
    value: mongoose.Schema.Types.Mixed
});
const Settings = mongoose.model('Settings', settingsSchema);

app.use(express.json());
app.use(express.static('client'));

let currentResult = { threeTop: "789", twoBottom: "45" };
let blockedNumbers = ["123", "77"]; // เลขอั้น / เลขปิด

io.on('connection', async (socket) => {
    console.log('Client connected:', socket.id);

    const sendInitialData = async () => {
        const orders = await Order.find().sort({ _id: -1 }).limit(100).catch(() => []);
        const users = await User.find().catch(() => []);
        socket.emit('init_data', { result: currentResult, orders, users, blockedNumbers });
    };
    sendInitialData();

    // ระบบส่งโพย พร้อมคำนวณเลขกลับ (6กลับ, 3กลับ, 19ประตู) และหักส่วนลด
    socket.emit('submit_bet', async (data) => {
        // data = { username, type, number, amount, discountRate }
        let numbersToBet = [];
        
        // ตัวอย่างการแตกเลขตามเงื่อนไข (เช่น 19 ประตู หรือ เลขกลับ)
        if (data.type === '19ประตู') {
            let num = data.number;
            for(let i=0; i<=9; i++) {
                numbersToBet.push(`${num}${i}`);
                if(num[0] !== i.toString()) numbersToBet.push(`${i}${num}`);
            }
        } else if (data.type === '3กลับ') {
            // สมมติหลักการสลับเลข 3 หลัก
            let n = data.number.split('');
            let perms = [
                n[0]+n[1]+n[2], n[0]+n[2]+n[1],
                n[1]+n[0]+n[2], n[1]+n[2]+n[0],
                n[2]+n[0]+n[1], n[2]+n[1]+n[0]
            ];
            numbersToBet = [...new Set(perms)];
        } else {
            numbersToBet.push(data.number);
        }

        let totalNetPay = 0;
        for (let num of numbersToBet) {
            // ตรวจสอบเลขลัอ้น
            if (blockedNumbers.includes(num)) {
                continue; // ข้ามเลขที่อั้นไม่รับแทง
            }
            let net = data.amount * (1 - (data.discountRate || 0.1));
            totalNetPay += net;

            const newOrder = new Order({
                username: data.username,
                type: data.type,
                number: num,
                amount: data.amount,
                discount: data.amount * (data.discountRate || 0.1),
                netPay: net,
                time: new Date().toLocaleTimeString()
            });
            await newOrder.save();
        }

        const updatedOrders = await Order.find().sort({ _id: -1 }).limit(100);
        io.emit('update_orders', updatedOrders);
    });

    // ระบบเอเยนต์จัดการเติมเครดิต / สร้างบัญชี
    socket.on('manage_user', async (actionData) => {
        if (actionData.action === 'add_credit') {
            await User.findOneAndUpdate(
                { username: actionData.username }, 
                { $inc: { credit: actionData.amount } }, 
                { upsert: true, new: true }
            );
        }
        const users = await User.find();
        io.emit('users_updated', users);
    });

    // ออกผลรางวัลและตรวจโพยอัตโนมัติ คำนวณยอดได้-เสีย
    socket.on('publish_result', async (resultData) => {
        currentResult = resultData;
        const allOrders = await Order.find();
        for (let ord of allOrders) {
            let isWin = false;
            if (ord.number === currentResult.twoBottom || currentResult.threeTop.endsWith(ord.number)) {
                isWin = true;
            }
            ord.status = isWin ? 'ถูกรางวัล 🎉' : 'ไม่ถูกรางวัล ❌';
            await ord.save();
        }
        const updatedOrders = await Order.find().sort({ _id: -1 }).limit(100);
        io.emit('update_result_and_orders', { result: currentResult, orders: updatedOrders });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Lao Lottery Advanced Server running on port ${PORT}`);
});