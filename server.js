const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const { createWorker } = require('tesseract.js'); // สำหรับอ่านโพยจากรูปภาพ

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('client'));

// เชื่อมต่อ MongoDB
mongoose.connect('mongodb://localhost:27017/lottery_full_system', {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => console.log('🔥 MongoDB System Connected')).catch(err => console.log('⚠️ Running in local mode'));

// Database Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    password: String,
    credit: { type: Number, default: 0 },
    role: { type: String, default: 'member' }, // 'agent' หรือ 'member'
    discountRate: { type: Number, default: 0.10 } // ส่วนลดเมมเบอร์ 10%
});
const User = mongoose.model('User', userSchema);

const blockedSchema = new mongoose.Schema({
    number: String,
    type: String // 'CLOSED' (ไม่ขายเลย) หรือ 'HALF' (จ่ายไม่เต็ม/จ่ายครึ่ง)
});
const BlockedNumber = mongoose.model('BlockedNumber', blockedSchema);

const orderSchema = new mongoose.Schema({
    username: String,
    bets: Array,           // รายการแทงทั้งหมด
    totalAmount: Number,   // ยอดรวมก่อนหักส่วนลด
    discount: Number,      // ส่วนลด
    netPay: Number,        // ยอดสุทธิหลังหักส่วนลด
    totalWin: { type: Number, default: 0 }, // ยอดที่ได้รางวัล
    profitCalculated: { type: Number, default: 0 }, // ยอดได้-เสียสุทธิ
    status: { type: String, default: 'รอผลรางวัล' },
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

// ==================== HELPER FUNCTIONS ====================

// 1. คำนวณกระจายเลข (19ประตู, 6กลับ, 3กลับ)
function expandBetNumbers(type, number) {
    let result = [];
    let cleanNum = number.toString().trim();

    if (type === '19ประตู') {
        for (let i = 0; i <= 9; i++) {
            result.push(`${cleanNum}${i}`);
            if (cleanNum !== i.toString()) result.push(`${i}${cleanNum}`);
        }
    } else if (type === '6กลับ' && cleanNum.length === 3) {
        let n = cleanNum.split('');
        let perms = [
            n[0]+n[1]+n[2], n[0]+n[2]+n[1],
            n[1]+n[0]+n[2], n[1]+n[2]+n[0],
            n[2]+n[0]+n[1], n[2]+n[1]+n[0]
        ];
        result = [...new Set(perms)];
    } else if (type === '3กลับ' && cleanNum.length === 3) {
        let n = cleanNum.split('');
        let perms = [n[0]+n[1]+n[2], n[1]+n[0]+n[2], n[2]+n[1]+n[0]];
        result = [...new Set(perms)];
    } else {
        result.push(cleanNum);
    }
    return result;
}

// 2. แปลงข้อความรูปแบบ 6x5 หรือ 3x5
function parseQuickBetFormat(text) {
    // รองรับรูปแบบเช่น "123 6x5", "45 3x5", "789x100"
    const lines = text.split('\n');
    let parsedBets = [];

    lines.forEach(line => {
        let matchMultiplier = line.match(/(\d+)\s+(\d+)x(\d+)/i); // เช่น 123 6x5
        if (matchMultiplier) {
            let num = matchMultiplier[1];
            let typeCode = matchMultiplier[2];
            let price = parseFloat(matchMultiplier[3]);
            let betType = typeCode === '6' ? '6กลับ' : (typeCode === '3' ? '3กลับ' : '3ตัวบน');
            parsedBets.push({ type: betType, number: num, amount: price });
            return;
        }

        let matchSimple = line.match(/(\d+)[xX](\d+)/i); // เช่น 45x10
        if (matchSimple) {
            parsedBets.push({
                type: matchSimple[1].length === 3 ? '3ตัวบน' : '2ตัวบน',
                number: matchSimple[1],
                amount: parseFloat(matchSimple[2])
            });
        }
    });
    return parsedBets;
}

// API สำหรับอ่านโพยจากรูปภาพ (OCR Engine)
app.post('/api/ocr-scan', upload.single('slipImage'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
        const worker = await createWorker('tha+eng');
        const ret = await worker.recognize(req.file.path);
        await worker.terminate();

        const extractedText = ret.data.text;
        const bets = parseQuickBetFormat(extractedText);
        res.json({ success: true, rawText: extractedText, parsedBets: bets });
    } catch (err) {
        res.status(500).json({ error: 'ไม่สามารถอ่านข้อความจากรูปภาพได้' });
    }
});

// ==================== SOCKET.IO REALTIME ====================
io.on('connection', (socket) => {
    
    // โหลดข้อมูลเริ่มต้น
    socket.on('get_initial_data', async () => {
        const blocked = await BlockedNumber.find().catch(() => []);
        const orders = await Order.find().sort({ _id: -1 }).limit(50).catch(() => []);
        socket.emit('init_data', { blocked, orders });
    });

    // สมาชิกส่งโพยหวย (คำนวณส่วนลด + เช็คเลขอั้น)
    socket.on('submit_order', async (data) => {
        // data = { username, rawBets }
        const user = await User.findOne({ username: data.username });
        if (!user) return socket.emit('order_error', 'ไม่พบชื่อผู้ใช้งาน');

        const blockedList = await BlockedNumber.find();
        let expandedBets = [];
        let grossTotal = 0;

        for (let b of data.rawBets) {
            let nums = expandBetNumbers(b.type, b.number);
            for (let n of nums) {
                // เช็คเลขอั้น
                let isClosed = blockedList.find(x => x.number === n && x.type === 'CLOSED');
                if (isClosed) {
                    socket.emit('order_error', `เลข ${n} ปิดรับแทง (เลขอั้น)`);
                    return;
                }

                let isHalf = blockedList.find(x => x.number === n && x.type === 'HALF');
                let effectivePayoutRate = isHalf ? 0.5 : 1.0; // จ่ายไม่เต็มจำนวน

                expandedBets.push({
                    type: b.type,
                    number: n,
                    amount: b.amount,
                    payoutRate: effectivePayoutRate,
                    note: isHalf ? 'จ่ายครึ่งราคา' : 'ปกติ'
                });

                grossTotal += b.amount;
            }
        }

        let discountAmt = grossTotal * (user.discountRate || 0.10);
        let netPay = grossTotal - discountAmt;

        if (user.credit < netPay) {
            return socket.emit('order_error', 'เครดิตไม่พอสำหรับส่งโพยนี้');
        }

        // ตัดเครดิตกระเป๋า
        user.credit -= netPay;
        await user.save();

        const newOrder = new Order({
            username: user.username,
            bets: expandedBets,
            totalAmount: grossTotal,
            discount: discountAmt,
            netPay: netPay
        });
        await newOrder.save();

        socket.emit('order_success', {
            order: newOrder,
            newCredit: user.credit
        });
        io.emit('new_order_added', newOrder);
    });

    // เอเยนต์เท่านั้น: เปิดบัญชีเมมเบอร์ & เติมเครดิต
    socket.on('agent_action', async (actionData) => {
        // actionData = { agentUsername, actionType, targetUser, amount, password }
        const agent = await User.findOne({ username: actionData.agentUsername, role: 'agent' });
        if (!agent) return socket.emit('agent_error', 'สิทธิ์ไม่ถูกต้อง (เอเยนต์เท่านั้น)');

        if (actionData.actionType === 'CREATE_MEMBER') {
            const newUser = new User({
                username: actionData.targetUser,
                password: actionData.password,
                credit: actionData.amount || 0,
                role: 'member'
            });
            await newUser.save();
            socket.emit('agent_success', `สร้างบัญชีสมาชิก ${actionData.targetUser} เรียบร้อย`);
        } else if (actionData.actionType === 'TOPUP_CREDIT') {
            await User.updateOne({ username: actionData.targetUser }, { $inc: { credit: actionData.amount } });
            socket.emit('agent_success', `เติมเครดิต ${actionData.amount} ให้ ${actionData.targetUser} สำเร็จ`);
        }
    });

    // เอเยนต์: ตั้งค่าเลขอั้น (ไม่ขาย / จ่ายไม่เต็ม)
    socket.on('set_blocked_number', async (blockData) => {
        // blockData = { number, type: 'CLOSED' | 'HALF' }
        await BlockedNumber.updateOne(
            { number: blockData.number },
            { type: blockData.type },
            { upsert: true }
        );
        io.emit('blocked_updated', await BlockedNumber.find());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Lottery System Engine live on port ${PORT}`));