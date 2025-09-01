const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const fileUpload = require('express-fileupload');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'richmore-secret-key-2023';

// Store connected users for targeted notifications
const connectedUsers = new Map();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // Join user to their room for private notifications
  socket.on('join-user-room', (userId) => {
    socket.join(`user-${userId}`);
    connectedUsers.set(socket.id, userId);
    console.log(`User ${userId} joined their room`);
  });
  
  // Handle payment reminder requests
  socket.on('request-payment-reminder', (userId) => {
    schedulePaymentReminder(userId);
  });
  
  socket.on('disconnect', () => {
    const userId = connectedUsers.get(socket.id);
    if (userId) {
      console.log(`User ${userId} disconnected`);
      connectedUsers.delete(socket.id);
    } else {
      console.log('Unknown user disconnected:', socket.id);
    }
  });
});

// Initialize required directories
const initDirectories = async () => {
  const directories = [
    path.join(__dirname, 'data'),
    path.join(__dirname, 'uploads'),
    path.join(__dirname, 'public', 'user'),
    path.join(__dirname, 'public', 'admin')
  ];

  for (const dir of directories) {
    try {
      await fs.mkdir(dir, { recursive: true });
      console.log(`Directory created: ${dir}`);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.error(`Error creating directory ${dir}:`, err);
      }
    }
  }
};

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/data', express.static(path.join(__dirname, 'data')));

// Helper functions
async function readJsonFile(filename) {
  const defaultData = {
    'users.json': [],
    'transactions.json': [],
    'savings_plans.json': [],
    'withdrawals.json': [],
    'receipts.json': [],
    'notifications.json': [],
    'config.json': {
      companyBankDetails: {
        bankName: "Sterling Bank",
        accountNumber: "0108270702",
        accountName: "Wealthlink"
      },
      monthlyPaymentAmount: 12000,
      withdrawalProcessingFee: 500,
      appSettings: {
        minPasswordLength: 6,
        maxLoginAttempts: 5
      }
    }
  };

  try {
    const filePath = path.join(__dirname, 'data', filename);
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return defaultData[filename] || [];
    }
    throw err;
  }
}

async function writeJsonFile(filename, data) {
  const filePath = path.join(__dirname, 'data', filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

function generateToken(user) {
  return crypto.createHash('sha256')
    .update(`${user.id}${user.email}${SECRET_KEY}`)
    .digest('hex');
}

// Handle base64 image upload and save to file
async function saveBase64Image(base64Data, userId) {
  try {
    const matches = base64Data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      throw new Error('Invalid base64 image data');
    }

    const imageType = matches[1];
    const imageData = matches[2];
    const buffer = Buffer.from(imageData, 'base64');
    const filename = `receipt-${userId}-${Date.now()}.${imageType}`;
    const filePath = path.join(__dirname, 'uploads', filename);

    await fs.writeFile(filePath, buffer);
    return filename;
  } catch (error) {
    console.error('Error saving image:', error);
    throw error;
  }
}

// Authentication middleware
const authenticateUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const users = await readJsonFile('users.json');
    const user = users.find(u => {
      const userToken = generateToken(u);
      return userToken === token;
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Send notification via Socket.io
function sendNotification(userId, notification) {
  io.to(`user-${userId}`).emit('notification', notification);
}

// Send dashboard update via Socket.io
function sendDashboardUpdate(userId, data) {
  io.to(`user-${userId}`).emit('dashboard-update', data);
}

// Send payment reminder notification
async function sendPaymentReminder(userId) {
  try {
    const [users, transactions, savingsPlans] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('transactions.json'),
      readJsonFile('savings_plans.json')
    ]);
    
    const user = users.find(u => u.id === userId);
    if (!user) return;
    
    const userTransactions = transactions.filter(t => t.userId === userId && t.type === 'payment' && t.status === 'completed');
    const userPlan = savingsPlans.find(sp => sp.userId === userId);
    
    if (!userPlan || userPlan.monthsCompleted >= 6) return;
    
    // Find the latest payment date
    let latestPaymentDate = new Date(userPlan.startDate || new Date());
    if (userTransactions.length > 0) {
      const latestTransaction = userTransactions.sort((a, b) => 
        new Date(b.date) - new Date(a.date)
      )[0];
      latestPaymentDate = new Date(latestTransaction.date);
    }
    
    // Calculate next payment date (1 month after last payment)
    const nextPaymentDate = new Date(latestPaymentDate);
    nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
    
    // Only send reminder if payment is due within the next 3 days
    const today = new Date();
    const daysUntilDue = Math.ceil((nextPaymentDate - today) / (1000 * 60 * 60 * 24));
    
    if (daysUntilDue <= 3 && daysUntilDue >= 0) {
      const message = `Your next payment of ₦12,000 is due on ${nextPaymentDate.toLocaleDateString()}`;
      
      const notification = {
        title: 'Payment Reminder',
        message: message,
        type: 'reminder',
        timestamp: new Date().toISOString(),
        paymentDueDate: nextPaymentDate.toISOString()
      };
      
      // Send via Socket.io
      io.to(`user-${userId}`).emit('payment-reminder', notification);
      
      // Also add to notifications.json
      const notifications = await readJsonFile('notifications.json');
      const newNotification = {
        id: `notif_${Date.now()}`,
        userId,
        title: 'Payment Reminder',
        message: message,
        type: 'reminder',
        isRead: false,
        createdAt: new Date().toISOString()
      };
      notifications.push(newNotification);
      await writeJsonFile('notifications.json', notifications);
    }
  } catch (error) {
    console.error('Error sending payment reminder:', error);
  }
}

// Schedule payment reminders for all eligible users
async function schedulePaymentReminders() {
  try {
    const users = await readJsonFile('users.json');
    
    for (const user of users) {
      await sendPaymentReminder(user.id);
    }
  } catch (error) {
    console.error('Error scheduling payment reminders:', error);
  }
}

// Schedule payment reminders every 24 hours
setInterval(schedulePaymentReminders, 24 * 60 * 60 * 1000);

// Also run once on server start
schedulePaymentReminders();

// ========== USER ROUTES ========== //

// User registration
app.post('/api/register', async (req, res) => {
  try {
    const { firstName, lastName, email, phone, accountNumber, accountName, bankName, referralCode } = req.body;
    
    if (!firstName || !lastName || !email || !phone || !accountNumber || !accountName || !bankName) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const users = await readJsonFile('users.json');
    
    if (users.some(u => u.email === email)) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    if (users.some(u => u.phone === phone)) {
      return res.status(400).json({ error: 'Phone number already registered' });
    }

    // Generate referral code
    const referralPrefix = firstName.toUpperCase().substring(0, 4);
    const randomChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let randomPart = '';
    for (let i = 0; i < 6; i++) {
      randomPart += randomChars.charAt(Math.floor(Math.random() * randomChars.length));
    }
    const userReferralCode = `${referralPrefix}-${randomPart}`;

    // Handle referral if provided
    let referredBy = null;
    if (referralCode) {
      const referrer = users.find(u => u.referralCode === referralCode);
      if (referrer) {
        referredBy = {
          userId: referrer.id,
          name: `${referrer.firstName} ${referrer.lastName}`
        };

        // Update referrer's referrals
        referrer.referrals = referrer.referrals || [];
        referrer.referrals.push({
          userId: `user_${users.length + 1}`,
          name: `${firstName} ${lastName}`,
          date: new Date().toISOString()
        });
        await writeJsonFile('users.json', users);
      }
    }

    const newUser = {
      id: `user_${Date.now()}`,
      firstName,
      lastName,
      email,
      phone,
      accountNumber,
      accountName,
      bankName,
      referralCode: userReferralCode,
      referredBy,
      referrals: [],
      balance: 0,
      isVerified: false,
      isAdmin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      avatar: null,
      loginAttempts: 0
    };

    users.push(newUser);
    await writeJsonFile('users.json', users);

    // Generate token (auto-login)
    const token = generateToken(newUser);

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: newUser.id,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        email: newUser.email,
        phone: newUser.phone,
        accountNumber: newUser.accountNumber,
        accountName: newUser.accountName,
        bankName: newUser.bankName,
        referralCode: newUser.referralCode,
        balance: newUser.balance,
        isVerified: newUser.isVerified
      },
      token
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const users = await readJsonFile('users.json');
    const user = users.find(u => u.email === email);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Generate token
    const token = generateToken(user);

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        accountNumber: user.accountNumber,
        accountName: user.accountName,
        bankName: user.bankName,
        referralCode: user.referralCode,
        balance: user.balance,
        isAdmin: user.isAdmin,
        isVerified: user.isVerified
      },
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user dashboard data
app.get('/api/dashboard', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [users, transactions, savingsPlans, notifications] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('transactions.json'),
      readJsonFile('savings_plans.json'),
      readJsonFile('notifications.json')
    ]);
    
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userTransactions = transactions.filter(t => t.userId === userId && !t.archived);
    const userSavingsPlan = savingsPlans.find(sp => sp.userId === userId);
    const userNotifications = notifications.filter(n => n.userId === userId && !n.isRead);
    
    // Calculate total saved
    const totalSaved = userTransactions
      .filter(t => t.type === 'payment' && t.status === 'completed')
      .reduce((sum, t) => sum + t.amount, 0);
    
    // Calculate months completed
    const uniqueMonths = new Set();
    userTransactions
      .filter(t => t.type === 'payment' && t.status === 'completed')
      .forEach(t => {
        const date = new Date(t.date);
        const monthYear = `${date.getFullYear()}-${date.getMonth()}`;
        uniqueMonths.add(monthYear);
      });
    const monthsCompleted = uniqueMonths.size;
    
    res.json({
      user: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        accountNumber: user.accountNumber,
        accountName: user.accountName,
        bankName: user.bankName,
        referralCode: user.referralCode,
        balance: user.balance,
        avatar: user.avatar,
        isVerified: user.isVerified
      },
      savingsPlan: userSavingsPlan || null,
      totalSaved,
      monthsCompleted,
      recentTransactions: userTransactions
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 3),
      unreadNotifications: userNotifications.length
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user transactions
app.get('/api/transactions', authenticateUser, async (req, res) => {
  try {
    const { type, status, limit } = req.query;
    const userId = req.user.id;
    
    const transactions = await readJsonFile('transactions.json');
    let userTransactions = transactions.filter(t => t.userId === userId && !t.archived);
    
    if (type) userTransactions = userTransactions.filter(t => t.type === type);
    if (status) userTransactions = userTransactions.filter(t => t.status === status);
    
    const sortedTransactions = userTransactions.sort((a, b) => 
      new Date(b.date) - new Date(a.date)
    );
    
    if (limit) {
      res.json(sortedTransactions.slice(0, parseInt(limit)));
    } else {
      res.json(sortedTransactions);
    }
  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit payment receipt
app.post('/api/payments', authenticateUser, async (req, res) => {
  try {
    const { receiptImage, amount } = req.body;
    const userId = req.user.id;
    
    if (!receiptImage || !amount) {
      return res.status(400).json({ error: 'Receipt image and amount are required' });
    }

    const config = await readJsonFile('config.json');
    if (amount !== config.monthlyPaymentAmount) {
      return res.status(400).json({ 
        error: `Payment amount must be ₦${config.monthlyPaymentAmount}` 
      });
    }

    // Save the base64 image to file
    const filename = await saveBase64Image(receiptImage, userId);

    const transactions = await readJsonFile('transactions.json');
    const newTransaction = {
      id: `txn_${Date.now()}`,
      userId,
      type: 'payment',
      amount,
      date: new Date().toISOString(),
      status: 'pending',
      receiptImage: filename
    };

    transactions.push(newTransaction);
    await writeJsonFile('transactions.json', transactions);

    // Create notification
    const notifications = await readJsonFile('notifications.json');
    const newNotification = {
      id: `notif_${Date.now()}`,
      userId,
      title: 'Payment Submitted',
      message: 'Your payment receipt has been submitted for review',
      type: 'payment',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    notifications.push(newNotification);
    await writeJsonFile('notifications.json', notifications);

    // Send real-time notification
    sendNotification(userId, newNotification);

    res.status(201).json({
      message: 'Payment submitted for review',
      transaction: newTransaction
    });
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user withdrawals
app.get('/api/withdrawals', authenticateUser, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const userId = req.user.id;
    
    const withdrawals = await readJsonFile('withdrawals.json');
    let userWithdrawals = withdrawals.filter(w => w.userId === userId);
    
    if (status) userWithdrawals = userWithdrawals.filter(w => w.status === status);
    
    const sortedWithdrawals = userWithdrawals.sort((a, b) => 
      new Date(b.date) - new Date(a.date)
    );
    
    if (limit) {
      res.json(sortedWithdrawals.slice(0, parseInt(limit)));
    } else {
      res.json(sortedWithdrawals);
    }
  } catch (error) {
    console.error('Withdrawals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Request withdrawal
app.post('/api/withdrawals', authenticateUser, async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.user.id;
    
    if (!amount || isNaN(amount)) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    const [users, savingsPlans, withdrawals, config] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('savings_plans.json'),
      readJsonFile('withdrawals.json'),
      readJsonFile('config.json')
    ]);
    
    const user = users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const userSavingsPlan = savingsPlans.find(sp => sp.userId === userId);
    
    if (!userSavingsPlan || userSavingsPlan.monthsCompleted < 6) {
      return res.status(400).json({ 
        error: 'Complete 6 months of savings before withdrawing' 
      });
    }

    const totalAmount = parseFloat(amount) + config.withdrawalProcessingFee;
    if (user.balance < totalAmount) {
      return res.status(400).json({ 
        error: `Insufficient balance (includes ₦${config.withdrawalProcessingFee} fee)` 
      });
    }

    const newWithdrawal = {
      id: `with_${Date.now()}`,
      userId,
      amount: parseFloat(amount),
      fee: config.withdrawalProcessingFee,
      status: 'pending',
      date: new Date().toISOString()
    };

    withdrawals.push(newWithdrawal);
    await writeJsonFile('withdrawals.json', withdrawals);

    // Create notification
    const notifications = await readJsonFile('notifications.json');
    const newNotification = {
      id: `notif_${Date.now()}`,
      userId,
      title: 'Withdrawal Requested',
      message: `Your withdrawal request of ₦${amount} has been submitted`,
      type: 'withdrawal',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    notifications.push(newNotification);
    await writeJsonFile('notifications.json', notifications);

    // Send real-time notification
    sendNotification(userId, newNotification);

    res.status(201).json({
      message: 'Withdrawal request submitted',
      withdrawal: newWithdrawal
    });
  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Handle receipt upload
app.post('/api/withdrawals/upload', authenticateUser, async (req, res) => {
  try {
    if (!req.files || !req.files.receipt) {
      return res.status(400).json({ error: 'Receipt image is required' });
    }

    const { message } = req.body;
    const userId = req.user.id;

    const receiptFile = req.files.receipt;
    const fileExt = path.extname(receiptFile.name);
    const fileName = `receipt_${userId}_${Date.now()}${fileExt}`;
    const filePath = path.join(__dirname, 'uploads', fileName);

    await receiptFile.mv(filePath);

    // Update withdrawals.json
    const withdrawals = await readJsonFile('withdrawals.json');
    const newWithdrawal = {
      id: `with_${Date.now()}`,
      userId,
      amount: 0,
      fee: 0,
      status: 'pending',
      receiptImage: fileName,
      adminMessage: message || '',
      date: new Date().toISOString()
    };
    withdrawals.push(newWithdrawal);
    await writeJsonFile('withdrawals.json', withdrawals);

    // Create notification for user
    const notifications = await readJsonFile('notifications.json');
    const newNotification = {
      id: `notif_${Date.now()}`,
      userId,
      title: 'Withdrawal Receipt Uploaded',
      message: message || 'A withdrawal receipt has been uploaded for your review',
      type: 'withdrawal',
      isRead: false,
      createdAt: new Date().toISOString(),
      withdrawalId: newWithdrawal.id
    };
    notifications.push(newNotification);
    await writeJsonFile('notifications.json', notifications);

    // Send real-time notification
    sendNotification(userId, newNotification);

    res.status(201).json({
      message: 'Receipt uploaded successfully',
      withdrawal: newWithdrawal
    });
  } catch (error) {
    console.error('Receipt upload error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// User confirm withdrawal receipt
app.post('/api/withdrawals/:id/confirm', authenticateUser, async (req, res) => {
  try {
    const withdrawalId = req.params.id;
    const { confirmed, note } = req.body;
    const userId = req.user.id;

    const [withdrawals, users, savingsPlans, transactions] = await Promise.all([
      readJsonFile('withdrawals.json'),
      readJsonFile('users.json'),
      readJsonFile('savings_plans.json'),
      readJsonFile('transactions.json')
    ]);

    const withdrawalIndex = withdrawals.findIndex(w => 
      w.id === withdrawalId && w.userId === userId
    );

    if (withdrawalIndex === -1) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    const withdrawal = withdrawals[withdrawalIndex];

    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ 
        error: 'Withdrawal is not pending confirmation' 
      });
    }

    if (!withdrawal.receiptImage) {
      return res.status(400).json({ 
        error: 'No receipt attached to this withdrawal' 
      });
    }

    if (confirmed) {
      withdrawals[withdrawalIndex].status = 'completed';
      withdrawals[withdrawalIndex].confirmedAt = new Date().toISOString();
      withdrawals[withdrawalIndex].confirmedBy = userId;
      
      // Delete the receipt image file
      try {
        await fs.unlink(path.join(__dirname, 'uploads', withdrawal.receiptImage));
      } catch (err) {
        console.error('Error deleting receipt image:', err);
      }

      // Reset user's savings plan completely
      const savingsPlanIndex = savingsPlans.findIndex(sp => sp.userId === userId);
      if (savingsPlanIndex !== -1) {
        // Remove the savings plan entirely
        savingsPlans.splice(savingsPlanIndex, 1);
        await writeJsonFile('savings_plans.json', savingsPlans);
      }

      // Reset user's balance to 0
      const userIndex = users.findIndex(u => u.id === userId);
      if (userIndex !== -1) {
        users[userIndex].balance = 0;
        await writeJsonFile('users.json', users);
      }

      // Mark all completed transactions as archived
      const userTransactions = transactions.filter(t => t.userId === userId);
      userTransactions.forEach(t => {
        if (t.status === 'completed') {
          t.archived = true;
        }
      });
      await writeJsonFile('transactions.json', transactions);
    } else {
      withdrawals[withdrawalIndex].status = 'rejected';
      withdrawals[withdrawalIndex].rejectedAt = new Date().toISOString();
      withdrawals[withdrawalIndex].rejectionNote = note || 'Rejected by user';
    }

    await writeJsonFile('withdrawals.json', withdrawals);

    // Create notification
    const notifications = await readJsonFile('notifications.json');
    const newNotification = {
      id: `notif_${Date.now()}`,
      userId,
      title: `Withdrawal ${confirmed ? 'Confirmed' : 'Rejected'}`,
      message: `You ${confirmed ? 'confirmed' : 'rejected'} a withdrawal receipt`,
      type: 'withdrawal',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    notifications.push(newNotification);
    await writeJsonFile('notifications.json', notifications);

    // Send real-time notification
    sendNotification(userId, newNotification);

    res.json({
      message: `Withdrawal ${confirmed ? 'confirmed' : 'rejected'} successfully`,
      withdrawal: withdrawals[withdrawalIndex]
    });
  } catch (error) {
    console.error('Withdrawal confirmation error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user profile
app.get('/api/profile', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const users = await readJsonFile('users.json');
    const user = users.find(u => u.id === userId);
    
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      accountNumber: user.accountNumber,
      accountName: user.accountName,
      bankName: user.bankName,
      referralCode: user.referralCode,
      referredBy: user.referredBy,
      referrals: user.referrals || [],
      avatar: user.avatar,
      isVerified: user.isVerified
    });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user profile
app.put('/api/profile', authenticateUser, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, accountNumber, accountName, bankName } = req.body;
    const userId = req.user.id;
    
    const users = await readJsonFile('users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

    // Validate email uniqueness
    if (email && email !== users[userIndex].email) {
      if (users.some(u => u.email === email && u.id !== userId)) {
        return res.status(400).json({ error: 'Email already in use' });
      }
    }

    // Validate phone uniqueness
    if (phone && phone !== users[userIndex].phone) {
      if (users.some(u => u.phone === phone && u.id !== userId)) {
        return res.status(400).json({ error: 'Phone number already in use' });
      }
    }

    users[userIndex] = {
      ...users[userIndex],
      firstName: firstName || users[userIndex].firstName,
      lastName: lastName || users[userIndex].lastName,
      email: email || users[userIndex].email,
      phone: phone || users[userIndex].phone,
      accountNumber: accountNumber || users[userIndex].accountNumber,
      accountName: accountName || users[userIndex].accountName,
      bankName: bankName || users[userIndex].bankName,
      updatedAt: new Date().toISOString()
    };

    await writeJsonFile('users.json', users);

    res.json({
      message: 'Profile updated successfully',
      user: {
        firstName: users[userIndex].firstName,
        lastName: users[userIndex].lastName,
        email: users[userIndex].email,
        phone: users[userIndex].phone,
        accountNumber: users[userIndex].accountNumber,
        accountName: users[userIndex].accountName,
        bankName: users[userIndex].bankName
      }
    });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update user avatar
app.put('/api/profile/avatar', authenticateUser, async (req, res) => {
  try {
    const { avatar } = req.body;
    const userId = req.user.id;
    
    if (!avatar) {
      return res.status(400).json({ error: 'Avatar data is required' });
    }

    const users = await readJsonFile('users.json');
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

    users[userIndex].avatar = avatar;
    users[userIndex].updatedAt = new Date().toISOString();

    await writeJsonFile('users.json', users);

    res.json({
      message: 'Avatar updated successfully',
      avatar
    });
  } catch (error) {
    console.error('Avatar error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get bank details
app.get('/api/bank-details', async (req, res) => {
  try {
    const config = await readJsonFile('config.json');
    res.json(config.companyBankDetails);
  } catch (error) {
    console.error('Bank details error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user notifications
app.get('/api/notifications', authenticateUser, async (req, res) => {
  try {
    const { limit } = req.query;
    const userId = req.user.id;
    
    const notifications = await readJsonFile('notifications.json');
    let userNotifications = notifications
      .filter(n => n.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    if (limit) {
      userNotifications = userNotifications.slice(0, parseInt(limit));
    }
    
    res.json(userNotifications);
  } catch (error) {
    console.error('Notifications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark notification as read
app.put('/api/notifications/:id/read', authenticateUser, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.id;
    
    const notifications = await readJsonFile('notifications.json');
    const notificationIndex = notifications.findIndex(n => 
      n.id === notificationId && n.userId === userId
    );
    
    if (notificationIndex === -1) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    notifications[notificationIndex].isRead = true;
    await writeJsonFile('notifications.json', notifications);

    res.json({
      message: 'Notification marked as read',
      notification: notifications[notificationIndex]
    });
  } catch (error) {
    console.error('Notification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get next payment date
app.get('/api/next-payment-date', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [transactions, savingsPlans] = await Promise.all([
      readJsonFile('transactions.json'),
      readJsonFile('savings_plans.json')
    ]);
    
    const userTransactions = transactions.filter(t => t.userId === userId && t.type === 'payment' && t.status === 'completed');
    const userPlan = savingsPlans.find(sp => sp.userId === userId);
    
    if (!userPlan || userPlan.monthsCompleted >= 6) {
      return res.json({ nextPaymentDate: null });
    }
    
    // Find the latest payment date
    let latestPaymentDate = new Date(userPlan.startDate || new Date());
    if (userTransactions.length > 0) {
      const latestTransaction = userTransactions.sort((a, b) => 
        new Date(b.date) - new Date(a.date)
      )[0];
      latestPaymentDate = new Date(latestTransaction.date);
    }
    
    // Calculate next payment date (1 month after last payment)
    const nextPaymentDate = new Date(latestPaymentDate);
    nextPaymentDate.setMonth(nextPaymentDate.getMonth() + 1);
    
    res.json({ nextPaymentDate: nextPaymentDate.toISOString() });
  } catch (error) {
    console.error('Next payment date error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Request payment reminder
app.post('/api/request-payment-reminder', authenticateUser, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Send payment reminder immediately
    await sendPaymentReminder(userId);
    
    res.json({ message: 'Payment reminder sent successfully' });
  } catch (error) {
    console.error('Payment reminder error:', error);
    res.status(500).json({ error: 'Failed to send payment reminder' });
  }
});

// ========== ADMIN ROUTES ========== //

// Admin dashboard stats
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const [users, transactions, savingsPlans, withdrawals, notifications] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('transactions.json'),
      readJsonFile('savings_plans.json'),
      readJsonFile('withdrawals.json'),
      readJsonFile('notifications.json')
    ]);

    const totalUsers = users.length;
    const totalSavings = transactions
      .filter(t => t.type === 'payment' && t.status === 'completed')
      .reduce((sum, t) => sum + t.amount, 0);
    const pendingWithdrawals = withdrawals.filter(w => w.status === 'pending').length;
    const pendingPayments = transactions.filter(t => t.type === 'payment' && t.status === 'pending').length;

    res.json({
      totalUsers,
      totalSavings,
      pendingWithdrawals,
      pendingPayments,
      recentActivity: notifications
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all users for admin
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await readJsonFile('users.json');
    res.json(users);
  } catch (error) {
    console.error('Admin users error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all transactions for admin
app.get('/api/admin/transactions', async (req, res) => {
  try {
    const { type, status } = req.query;
    let transactions = await readJsonFile('transactions.json');
    
    if (type) transactions = transactions.filter(t => t.type === type);
    if (status) transactions = transactions.filter(t => t.status === status);
    
    res.json(transactions);
  } catch (error) {
    console.error('Admin transactions error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update transaction status (admin)
app.put('/api/admin/transactions/:id', async (req, res) => {
  try {
    const transactionId = req.params.id;
    const { status, adminNote } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const [transactions, users] = await Promise.all([
      readJsonFile('transactions.json'),
      readJsonFile('users.json')
    ]);

    const transactionIndex = transactions.findIndex(t => t.id === transactionId);
    if (transactionIndex === -1) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const transaction = transactions[transactionIndex];
    const oldStatus = transaction.status;
    transaction.status = status;
    transaction.adminNote = adminNote || transaction.adminNote;
    transaction.updatedAt = new Date().toISOString();

    // If payment is being approved, update user balance
    if (transaction.type === 'payment' && status === 'completed' && oldStatus !== 'completed') {
      const userIndex = users.findIndex(u => u.id === transaction.userId);
      if (userIndex !== -1) {
        users[userIndex].balance = (users[userIndex].balance || 0) + transaction.amount;
        
        // Update or create savings plan
        const savingsPlans = await readJsonFile('savings_plans.json');
        let savingsPlan = savingsPlans.find(sp => sp.userId === transaction.userId);
        
        if (!savingsPlan) {
          savingsPlan = {
            id: `plan_${Date.now()}`,
            userId: transaction.userId,
            startDate: new Date().toISOString(),
            monthsCompleted: 0,
            totalSaved: 0
          };
          savingsPlans.push(savingsPlan);
        }
        
        // Update months completed based on payment count
        const userTransactions = transactions.filter(t => 
          t.userId === transaction.userId && 
          t.type === 'payment' && 
          t.status === 'completed'
        );
        
        savingsPlan.monthsCompleted = userTransactions.length;
        savingsPlan.totalSaved = userTransactions.reduce((sum, t) => sum + t.amount, 0);
        
        await writeJsonFile('savings_plans.json', savingsPlans);
      }
    }

    await Promise.all([
      writeJsonFile('transactions.json', transactions),
      writeJsonFile('users.json', users)
    ]);

    // Create notification for user
    const notifications = await readJsonFile('notifications.json');
    const newNotification = {
      id: `notif_${Date.now()}`,
      userId: transaction.userId,
      title: `Payment ${status === 'completed' ? 'Approved' : 'Rejected'}`,
      message: `Your payment of ₦${transaction.amount} has been ${status === 'completed' ? 'approved' : 'rejected'}`,
      type: 'payment',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    notifications.push(newNotification);
    await writeJsonFile('notifications.json', notifications);

    // Send real-time notification
    sendNotification(transaction.userId, newNotification);

    res.json({
      message: 'Transaction updated successfully',
      transaction
    });
  } catch (error) {
    console.error('Admin transaction update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all withdrawals for admin
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    const withdrawals = await readJsonFile('withdrawals.json');
    res.json(withdrawals);
  } catch (error) {
    console.error('Admin withdrawals error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update withdrawal status (admin)
app.put('/api/admin/withdrawals/:id', async (req, res) => {
  try {
    const withdrawalId = req.params.id;
    const { status, adminNote } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const [withdrawals, users] = await Promise.all([
      readJsonFile('withdrawals.json'),
      readJsonFile('users.json')
    ]);

    const withdrawalIndex = withdrawals.findIndex(w => w.id === withdrawalId);
    if (withdrawalIndex === -1) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    const withdrawal = withdrawals[withdrawalIndex];
    const oldStatus = withdrawal.status;
    withdrawal.status = status;
    withdrawal.adminNote = adminNote || withdrawal.adminNote;
    withdrawal.updatedAt = new Date().toISOString();

    // If withdrawal is being approved, update user balance
    if (status === 'completed' && oldStatus !== 'completed') {
      const userIndex = users.findIndex(u => u.id === withdrawal.userId);
      if (userIndex !== -1) {
        users[userIndex].balance = (users[userIndex].balance || 0) - (withdrawal.amount + withdrawal.fee);
      }
    }

    await Promise.all([
      writeJsonFile('withdrawals.json', withdrawals),
      writeJsonFile('users.json', users)
    ]);

    // Create notification for user
    const notifications = await readJsonFile('notifications.json');
    const newNotification = {
      id: `notif_${Date.now()}`,
      userId: withdrawal.userId,
      title: `Withdrawal ${status === 'completed' ? 'Approved' : 'Rejected'}`,
      message: `Your withdrawal request of ₦${withdrawal.amount} has been ${status === 'completed' ? 'approved' : 'rejected'}`,
      type: 'withdrawal',
      isRead: false,
      createdAt: new Date().toISOString()
    };
    notifications.push(newNotification);
    await writeJsonFile('notifications.json', notifications);

    // Send real-time notification
    sendNotification(withdrawal.userId, newNotification);

    res.json({
      message: 'Withdrawal updated successfully',
      withdrawal
    });
  } catch (error) {
    console.error('Admin withdrawal update error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all notifications for admin
app.get('/api/admin/notifications', async (req, res) => {
  try {
    const notifications = await readJsonFile('notifications.json');
    res.json(notifications);
  } catch (error) {
    console.error('Admin notifications error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send notification to all users (admin)
app.post('/api/admin/notifications', async (req, res) => {
  try {
    const { title, message, type } = req.body;
    
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

    const [users, notifications] = await Promise.all([
      readJsonFile('users.json'),
      readJsonFile('notifications.json')
    ]);

    const newNotification = {
      id: `notif_${Date.now()}`,
      userId: 'all',
      title,
      message,
      type: type || 'announcement',
      isRead: false,
      createdAt: new Date().toISOString()
    };

    notifications.push(newNotification);
    await writeJsonFile('notifications.json', notifications);

    // Send real-time notification to all connected users
    io.emit('notification', newNotification);

    res.status(201).json({
      message: 'Notification sent to all users',
      notification: newNotification
    });
  } catch (error) {
    console.error('Admin notification error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update app settings (admin)
app.put('/api/admin/settings', async (req, res) => {
  try {
    const { companyBankDetails, monthlyPaymentAmount, withdrawalProcessingFee, appSettings } = req.body;
    
    const config = await readJsonFile('config.json');
    
    if (companyBankDetails) {
      config.companyBankDetails = {
        ...config.companyBankDetails,
        ...companyBankDetails
      };
    }
    
    if (monthlyPaymentAmount) {
      config.monthlyPaymentAmount = monthlyPaymentAmount;
    }
    
    if (withdrawalProcessingFee) {
      config.withdrawalProcessingFee = withdrawalProcessingFee;
    }
    
    if (appSettings) {
      config.appSettings = {
        ...config.appSettings,
        ...appSettings
      };
    }
    
    await writeJsonFile('config.json', config);
    
    res.json({
      message: 'Settings updated successfully',
      config
    });
  } catch (error) {
    console.error('Admin settings error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'index.html'));
});


// ========== PAGE ROUTES ========== //

// User Pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'index.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'signup.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'dashboard.html'));
});

app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'profile.html'));
});

app.get('/save', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'save.html'));
});

app.get('/transactions', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'transactions.html'));
});

app.get('/withdraw', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user', 'withdraw.html'));
});

// Admin Pages
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-dashboard.html'));
});

app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-dashboard.html'));
});

app.get('/admin/payments', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-payments.html'));
});

app.get('/admin/withdrawals', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-withdrawal.html'));
});

app.get('/admin/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'admin-users.html'));
});


// Initialize server
const startServer = async () => {
  try {
    await initDirectories();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();