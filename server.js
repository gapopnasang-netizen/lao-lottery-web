const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { createWorker } = require('tesseract.js');

const JWT_SECRET = process.env.JWT_SECRET || 'SUPER_SECRET_LOTTERY_KEY_2026';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/lottery_production';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const upload = multer({ dest: 'uploads/' });

// Security Middlewares
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.static('client'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use(limiter);

// Connect DB
mongoose.connect(MONGO_URI)
  .then(() => console.log('🛡️ Database Connected (Production Secured)'))
  .catch(err => console.log('⚠️ Local DB fallback:', err.message));

// Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    credit: { type: Number, default: 0 },
    role: { type: String, default: 'member' },
    discountRate: { type: Number, default: 0.10 }
});
const User = mongoose.model('User', userSchema);

const transactionSchema = new mongoose.Schema({
    username: String,
    type: String, // 'DEPOSIT', 'BET', 'WIN', 'COMMISSION'
    amount: Number,
    balanceAfter: Number,
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const blockedSchema = new mongoose.Schema({
    number: String,
    type: String // 'CLOSED' หรือ 'HALF'
});
const BlockedNumber = mongoose.model('BlockedNumber', blockedSchema);

const orderSchema = new mongoose.Schema({
    username: String,
    bets: Array,
    totalAmount: Number,
    discount: Number,
    netPay: Number,
    status: { type: String, default: 'รอผลรางวัล' },
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// Helper Engine
function expandBetNumbers(type, number) {
    let result = [];
    let clean = number.toString().trim();
    if (type === '19ประตู') {
        for (let i = 0; i <= 9; i++) {
            result.push(`${clean}${i}`);
            if (clean !== i.toString()) result.push(`${i}${clean}`);
        }
    } else if (type === '6กลับ' && clean.length === 3) {
        let n = clean.split('');
        result = [...new Set([
            n[0]+n[1]+n[2], n[0]+n[2]+n[1], n[1]+n[0]+n[2],
            n[1]+n[2]+n[0], n[2]+n[0]+n[1], n[2]+n[1]+n[0]
        ])];
    } else if (type === '3กลับ' && clean.length === 3) {
        let n = clean.split('');
        result = [...new Set([n[0]+n[1]+n[2], n[1]+n[0]+n[2], n[2]+n[1]+n[0]])];
    } else {
        result.push(clean);
    }
    return result;
}

// APIs
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, username: user.username, role: user.role, credit: user.credit });
});

app.post('/api/ocr-scan', upload.single('slipImage'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์' });
        const worker = await createWorker('tha+eng');
        const ret = await worker.recognize(req.file.path);
        await worker.terminate();
        res.json({ success: true, text: ret.data.text });
    } catch (e) {
        res.status(500).json({ error: 'OCR Error' });
    }
});

// Real-time Gateway
io.on('connection', (socket) => {
    socket.on('get_initial_data', async () => {
        socket.emit('init_data', {
            blocked: await BlockedNumber.find().catch(() => []),
            orders: await Order.find().sort({ _id: -1 }).limit(30).catch(() => [])
        });
    });

    // ส่งโพย
    socket.on('submit_order', async (data) => {
        const user = await User.findOne({ username: data.username });
        if (!user) return socket.emit('order_error', 'ไม่พบผู้ใช้');

        const blockedList = await BlockedNumber.find();
        let expandedBets = [];
        let gross = 0;

        for (let b of data.rawBets) {
            let nums = expandBetNumbers(b.type, b.number);
            for (let n of nums) {
                let isClosed = blockedList.find(x => x.number === n && x.type === 'CLOSED');
                if (isClosed) return socket.emit('order_error', `เลข ${n} ปิดรับแทง`);

                let isHalf = blockedList.find(x => x.number === n && x.type === 'HALF');
                expandedBets.push({
                    type: b.type, number: n, amount: b.amount,
                    payoutRate: isHalf ? 0.5 : 1.0,
                    note: isHalf ? 'จ่ายครึ่งราคา' : 'ปกติ'
                });
                gross += b.amount;
            }
        }

        let disc = gross * (user.discountRate || 0.10);
        let net = gross - disc;

        if (user.credit < net) return socket.emit('order_error', 'เครดิตไม่พอ');

        user.credit -= net;
        await user.save();

        await new Transaction({ username: user.username, type: 'BET', amount: -net, balanceAfter: user.credit }).save();

        const order = new Order({ username: user.username, bets: expandedBets, totalAmount: gross, discount: disc, netPay: net });
        await order.save();

        socket.emit('order_success', { order, newCredit: user.credit });
        io.emit('new_order_added', order);
    });

    // เอเยนต์: เปิดบัญชี / เติมเงิน
    socket.on('agent_action', async (data) => {
        const agent = await User.findOne({ username: data.agentUsername, role: 'agent' });
        if (!agent) return socket.emit('agent_error', 'ไม่มีสิทธิ์ทำรายการ');

        if (data.actionType === 'CREATE_MEMBER') {
            const hashPassword = await bcrypt.hash(data.password, 10);
            await new User({ username: data.targetUser, password: hashPassword, credit: data.amount || 0 }).save();
            socket.emit('agent_success', `สร้างบัญชี ${data.targetUser} สำเร็จ`);
        } else if (data.actionType === 'TOPUP_CREDIT') {
            const u = await User.findOneAndUpdate({ username: data.targetUser }, { $inc: { credit: data.amount } }, { new: true });
            if (u) {
                await new Transaction({ username: u.username, type: 'DEPOSIT', amount: data.amount, balanceAfter: u.credit }).save();
                socket.emit('agent_success', `เติมเครดิต ${data.amount} ให้ ${data.targetUser} สำเร็จ`);
            }
        }
    });

    // ตั้งค่าเลขอั้น
    socket.on('set_blocked', async (data) => {
        await BlockedNumber.updateOne({ number: data.number }, { type: data.type }, { upsert: true });
        io.emit('blocked_updated', await BlockedNumber.find());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Production Server running on port ${PORT}`));