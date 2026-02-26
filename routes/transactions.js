const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { auth, authorize, checkModulePermission } = require('../middleware/auth');
const Transaction = require('../models/Transaction');
const Property = require('../models/Property');
const Lead = require('../models/Lead');
const Payment = require('../models/Payment');
const Agency = require('../models/Agency');
const User = require('../models/User');
const notificationService = require('../services/notificationService');
const emailService = require('../services/emailService');
const paymentService = require('../services/paymentService');

// @route   GET /api/transactions/analytics/revenue
// @desc    Get revenue analytics
// @access  Private
router.get('/analytics/revenue', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const { startDate, endDate, agency, minAmount, maxAmount } = req.query;
    const query = { status: 'completed' };

    if (agency) {
      query.agency = agency;
    } else if (req.user.role === 'agency_admin') {
      query.agency = req.user.agency;
    }

    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    if (minAmount || maxAmount) {
      query.amount = {};
      if (minAmount) query.amount.$gte = Number(minAmount);
      if (maxAmount) query.amount.$lte = Number(maxAmount);
    }

    const transactions = await Transaction.find(query)
      .populate('property', 'title')
      .populate('agent', 'firstName lastName')
      .populate('lead', 'contact');

    // Calculate totals
    const totalRevenue = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    const totalCommission = transactions.reduce((sum, t) => sum + (t.commission?.amount || 0), 0);
    const totalTransactions = transactions.length;

    // Revenue by type
    const revenueByType = {
      sale: transactions.filter(t => t.type === 'sale').reduce((sum, t) => sum + (t.amount || 0), 0),
      rent: transactions.filter(t => t.type === 'rent').reduce((sum, t) => sum + (t.amount || 0), 0)
    };

    // Revenue by month (last 12 months)
    const monthlyRevenue = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const monthTransactions = transactions.filter(t => {
        const tDate = new Date(t.transactionDate);
        return tDate >= monthStart && tDate <= monthEnd;
      });
      monthlyRevenue.push({
        month: monthStart.toLocaleString('default', { month: 'short', year: 'numeric' }),
        revenue: monthTransactions.reduce((sum, t) => sum + (t.amount || 0), 0),
        count: monthTransactions.length
      });
    }

    // Top performing agents
    const agentRevenue = {};
    transactions.forEach(t => {
      if (t.agent) {
        const agentId = t.agent._id.toString();
        if (!agentRevenue[agentId]) {
          agentRevenue[agentId] = {
            agent: t.agent,
            revenue: 0,
            commission: 0,
            count: 0
          };
        }
        agentRevenue[agentId].revenue += t.amount || 0;
        agentRevenue[agentId].commission += t.commission?.amount || 0;
        agentRevenue[agentId].count += 1;
      }
    });

    const topAgents = Object.values(agentRevenue)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    res.json({
      summary: {
        totalRevenue,
        totalCommission,
        totalTransactions,
        revenueByType,
        averageTransactionValue: totalTransactions > 0 ? totalRevenue / totalTransactions : 0
      },
      monthlyRevenue,
      topAgents
    });
  } catch (error) {
    console.error('Revenue analytics error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/transactions
// @desc    Get all transactions
// @access  Private
router.get('/', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const { status, type, startDate, endDate, agency, agent, minAmount, maxAmount, search } = req.query;
    const query = {};

    if (status) query.status = status;
    if (type) query.type = type;
    if (agency) query.agency = agency;
    if (agent) query.agent = agent;

    if (startDate || endDate) {
      query.transactionDate = {};
      if (startDate) query.transactionDate.$gte = new Date(startDate);
      if (endDate) query.transactionDate.$lte = new Date(endDate);
    }

    // Budget range filter
    if (minAmount || maxAmount) {
      query.amount = {};
      if (minAmount) query.amount.$gte = Number(minAmount);
      if (maxAmount) query.amount.$lte = Number(maxAmount);
    }

    // Role-based filtering
    if (req.user.role === 'agency_admin') {
      query.agency = req.user.agency;
    } else if (req.user.role === 'agent') {
      query.agent = req.user.id;
    }

    // Search filter (handles property title, lead name, agent name)
    // For complex search across populated fields, we might need a separate find or aggregation
    // But for now, we'll populate and filter or use aggregation if needed.
    // Given the current structure, we'll stick to basic query and populate.

    // If search is provided, we might need to find matching properties/leads/agents first
    if (search) {
      const searchRegex = new RegExp(search, 'i');

      // Find matching properties
      const properties = await Property.find({ title: searchRegex }).select('_id');
      const propertyIds = properties.map(p => p._id);

      // Find matching users (agents)
      const users = await User.find({
        $or: [
          { firstName: searchRegex },
          { lastName: searchRegex }
        ]
      }).select('_id');
      const userIds = users.map(u => u._id);

      // Find matching leads
      const leads = await Lead.find({
        $or: [
          { 'contact.firstName': searchRegex },
          { 'contact.lastName': searchRegex },
          { 'contact.email': searchRegex }
        ]
      }).select('_id');
      const leadIds = leads.map(l => l._id);

      query.$or = [
        { property: { $in: propertyIds } },
        { agent: { $in: userIds } },
        { lead: { $in: leadIds } }
      ];
    }

    const transactions = await Transaction.find(query)
      .populate('property', 'title slug')
      .populate('lead', 'contact leadId status')
      .populate('agency', 'name')
      .populate('agent', 'firstName lastName email phone')
      .sort({ transactionDate: -1 })
      .limit(500); // Increased limit for admin view

    res.json(transactions);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/transactions/my-transactions
// @desc    Get transactions for current customer
// @access  Private
router.get('/my-transactions', auth, async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) {
      console.log('my-transactions: No user email found');
      return res.json([]);
    }

    // Use mongoose.model to ensure models are correctly registered
    const LeadModel = mongoose.model('Lead');
    const TransactionModel = mongoose.model('Transaction');

    // Find leads for this customer by email
    // We use a simple find().select() instead of distinct() to be safer
    const leads = await LeadModel.find({ 'contact.email': userEmail }).select('_id');
    const customerLeadIds = leads.map(l => l._id);

    if (!customerLeadIds || customerLeadIds.length === 0) {
      return res.json([]);
    }

    const transactions = await TransactionModel.find({
      lead: { $in: customerLeadIds }
    })
      .populate({
        path: 'property',
        select: 'title location price images slug'
      })
      .populate({
        path: 'agency',
        select: 'name logo contact'
      })
      .populate({
        path: 'agent',
        select: 'firstName lastName email'
      })
      .sort({ transactionDate: -1 });

    // Fetch payments for these transactions
    const Payment = mongoose.model('Payment');
    const transactionIds = transactions.map(t => t._id);
    const payments = await Payment.find({ transaction: { $in: transactionIds } });

    // Combine transactions with their payment info
    const transactionsWithPayments = transactions.map(t => {
      const payment = payments.find(p => p.transaction.toString() === t._id.toString());
      return {
        ...t.toObject(),
        payment
      };
    });

    res.json(transactionsWithPayments);
  } catch (error) {
    console.error('Get my transactions error:', error);
    res.status(500).json({
      message: 'Server error',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});
// @route   GET /api/transactions/my-transactions/:id
// @desc    Get transaction details for current customer
// @access  Private
router.get('/my-transactions/:id', auth, async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ message: 'User email not found' });
    }

    const transaction = await Transaction.findById(req.params.id)
      .populate('property')
      .populate('agency')
      .populate('agent', 'firstName lastName email phone')
      .populate('lead');

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Check if this transaction belongs to the user (via lead email)
    if (transaction.lead?.contact?.email !== userEmail) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Find associated payment
    let payment = await Payment.findOne({ transaction: transaction._id });

    // Auto-repair: If transaction is completed but payment record is missing
    if (transaction.status === 'completed' && !payment) {
      try {
        // Payment requires agency: resolve from transaction or lead
        const agencyId = transaction.agency?._id ?? transaction.agency ?? transaction.lead?.agency?._id ?? transaction.lead?.agency;
        if (!agencyId) {
          console.warn(`Auto-repair skipped for transaction ${transaction._id}: no agency on transaction or lead`);
        } else {
          console.log(`Auto-repairing missing payment for transaction ${transaction._id}`);
          payment = new Payment({
            transaction: transaction._id,
            lead: transaction.lead?._id,
            property: transaction.property?._id,
            agency: agencyId,
            amount: transaction.amount || 0,
            currency: 'USD',
            paymentMethod: 'other',
            gateway: 'none',
            gatewayPaymentId: 'restored_' + Date.now(),
            status: 'completed',
            receipt: {
              number: 'RCP-' + Date.now(),
              url: '#'
            },
            description: 'Automatically restored payment record',
            paymentDate: transaction.transactionDate || transaction.updatedAt || new Date(),
            createdBy: req.user.id // The user triggering the repair (customer)
          });
          await payment.save();
        }
      } catch (repairError) {
        console.error('Failed to auto-repair payment:', repairError);
        // Continue without payment, will likely fail on frontend but we tried
      }
    }

    res.json({
      transaction,
      payment
    });
  } catch (error) {
    console.error('Get my transaction detail error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/transactions/:id
// @desc    Get transaction by ID
// @access  Private
router.get('/:id', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id)
      .populate('property')
      .populate('lead')
      .populate('agency')
      .populate('agent')
      .populate('createdBy');

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin' && transaction.agency.toString() !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(transaction);
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/transactions
// @desc    Create new transaction
// @access  Private (Super Admin, Agency Admin)
router.post('/', [
  auth,
  checkModulePermission('leads', 'edit'),
  body('property').isMongoId().withMessage('Valid property ID is required'),
  body('lead').isMongoId().withMessage('Valid lead ID is required'),
  body('type').isIn(['sale', 'rent']).withMessage('Type must be sale or rent'),
  body('amount').isNumeric().withMessage('Amount is required'),
  body('agent').isMongoId().withMessage('Valid agent ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const property = await Property.findById(req.body.property);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    const lead = await Lead.findById(req.body.lead);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin' && property.agency.toString() !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const transactionData = {
      ...req.body,
      agency: property.agency,
      createdBy: req.user.id
    };

    // Calculate commission if percentage provided
    if (req.body.commission?.percentage) {
      transactionData.commission = {
        percentage: req.body.commission.percentage,
        amount: (req.body.amount * req.body.commission.percentage) / 100
      };
    }

    const transaction = new Transaction(transactionData);
    await transaction.save();

    // Update lead status and booking details (Always happen on booking creation)
    lead.status = 'booked';
    lead.property = req.body.property;

    // Initialize booking object if it doesn't exist
    if (!lead.booking) {
      lead.booking = {};
    }

    // Update booking details from transaction
    lead.booking.bookingAmount = req.body.amount;
    lead.booking.bookingDate = req.body.transactionDate || new Date();
    lead.booking.paymentMode = req.body.paymentMethod || 'other';

    // Handle unit number from erpSync if provided
    if (req.body.erpSync && req.body.erpSync.unitNumber) {
      lead.booking.unitNumber = req.body.erpSync.unitNumber;
    }

    if (req.body.status === 'completed') {
      lead.convertedAt = new Date();
    }

    await lead.save();

    // Update property status
    if (req.body.status === 'completed') {
      if (req.body.type === 'sale') {
        property.status = 'sold';
      } else if (req.body.type === 'rent') {
        property.status = 'rented';
      }
    } else {
      // Pending transaction = Property is Booked/Reserved
      property.status = 'booked';
    }
    await property.save();

    const populatedTransaction = await Transaction.findById(transaction._id)
      .populate('property')
      .populate('lead')
      .populate('agency')
      .populate('agent');

    res.status(201).json(populatedTransaction);
  } catch (error) {
    console.error('Create transaction error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/transactions/:id
// @desc    Update transaction
// @access  Private (Super Admin, Agency Admin)
router.put('/:id', [
  auth,
  checkModulePermission('leads', 'edit'),
  body('status').optional().isIn(['pending', 'completed', 'cancelled', 'refunded']),
  body('amount').optional().isNumeric()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin' && transaction.agency.toString() !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Update transaction
    Object.assign(transaction, req.body);

    // Recalculate commission if amount or percentage changed
    if (req.body.amount || req.body.commission?.percentage) {
      const amount = req.body.amount || transaction.amount;
      const percentage = req.body.commission?.percentage || transaction.commission?.percentage;
      if (percentage) {
        transaction.commission = {
          percentage: percentage,
          amount: (amount * percentage) / 100
        };
      }
    }

    await transaction.save();

    // Update property and lead status if transaction status changed
    if (req.body.status === 'completed') {
      const property = await Property.findById(transaction.property);
      if (property) {
        if (transaction.type === 'sale') {
          property.status = 'sold';
        } else if (transaction.type === 'rent') {
          property.status = 'rented';
        }
        await property.save();
      }

      // Also ensure lead status is booked/closed
      const lead = await Lead.findById(transaction.lead);
      if (lead) {
        lead.status = 'booked';
        lead.convertedAt = new Date();
        await lead.save();
      }
    }

    const updatedTransaction = await Transaction.findById(transaction._id)
      .populate('property')
      .populate('lead')
      .populate('agency')
      .populate('agent');

    // When admin finalizes (status completed): ensure Payment exists, generate invoice PDF, send email with attachment
    if (req.body.status === 'completed') {
      (async () => {
        try {
          let payment = await Payment.findOne({ transaction: transaction._id });
          const pd = transaction.paymentDetails || {};
          const amountPaid = Number(pd.amountPaid ?? transaction.amount ?? 0);
          const paymentMethod = (pd.paymentMethod || 'bank_transfer').toLowerCase().replace(/-/g, '_');
          const paymentMethodMap = { cash: 'cash', cheque: 'cheque', bank_transfer: 'bank_transfer', credit_card: 'other', other: 'other' };
          const mappedMethod = paymentMethodMap[paymentMethod] || 'other';

          if (!payment) {
            payment = new Payment({
              transaction: transaction._id,
              lead: transaction.lead,
              property: transaction.property,
              agency: transaction.agency,
              amount: amountPaid,
              currency: transaction.currency || 'INR',
              paymentMethod: mappedMethod,
              gateway: 'none',
              status: 'completed',
              paymentDate: pd.paymentDate || transaction.transactionDate || new Date(),
              receipt: {
                number: `RCP-${Date.now()}-${String(transaction._id).slice(-6)}`,
                url: `/api/payments/receipt`
              },
              createdBy: req.user.id
            });
            await payment.save();
          } else {
            payment.amount = amountPaid;
            payment.paymentMethod = mappedMethod;
            payment.paymentDate = pd.paymentDate || payment.paymentDate;
            payment.status = 'completed';
            if (!payment.receipt?.number) {
              payment.receipt = payment.receipt || {};
              payment.receipt.number = `RCP-${Date.now()}-${String(transaction._id).slice(-6)}`;
              payment.receipt.url = payment.receipt.url || '/api/payments/receipt';
            }
            await payment.save();
          }

          const invoicePdfBuffer = await paymentService.generateReceiptPDFBuffer(payment._id.toString());
          const propertyTitle = (updatedTransaction.property?.title || 'property').replace(/\s+/g, '-');
          const fileName = `invoice-${propertyTitle}.pdf`;
          await emailService.sendBookingFinalizedEmail(updatedTransaction, { invoicePdfBuffer, fileName });
        } catch (err) {
          console.error('Error in sendBookingFinalizedEmail background task:', err);
        }
      })();
    }

    res.json(updatedTransaction);
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/transactions/:id
// @desc    Delete transaction
// @access  Private (Super Admin only)
router.delete('/:id', auth, authorize('super_admin'), async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    await Transaction.findByIdAndDelete(req.params.id);
    res.json({ message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});



// @route   POST /api/transactions/my-transactions/:id/confirm
// @desc    Confirm and pay for a transaction (Mock)
// @access  Private
router.post('/my-transactions/:id/confirm', auth, async (req, res) => {
  try {
    const userEmail = req.user?.email;
    if (!userEmail) {
      return res.status(401).json({ message: 'User email not found' });
    }

    const transaction = await Transaction.findById(req.params.id)
      .populate('lead')
      .populate('property');

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Check if this transaction belongs to the user (via lead email)
    if (transaction.lead?.contact?.email !== userEmail) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Handle Idempotency and Repair
    if (transaction.status === 'completed') {
      const existingPayment = await Payment.findOne({ transaction: transaction._id });
      if (existingPayment) {
        return res.status(200).json({
          message: 'Transaction already confirmed',
          transaction,
          payment: existingPayment
        });
      }
      // If completed but no payment exists for some reason, proceed to create payment (repair mode)
    } else if (transaction.status === 'pending') {
      // Normal flow: Customer confirms, but status stays pending until Admin finalizes
      transaction.customerConfirmed = true;
      transaction.transactionDate = new Date();
      await transaction.save();

    } else {
      return res.status(400).json({
        message: `Transaction cannot be confirmed. Current status: ${transaction.status}. Only 'pending' transactions can be confirmed.`
      });
    }

    // Send notification about property confirmation
    await notificationService.notifyPropertyConfirmation(transaction);

    res.json({
      message: 'Property confirmed successfully. Notifications have been sent.',
      transaction
    });
  } catch (error) {
    console.error('Confirm transaction error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
