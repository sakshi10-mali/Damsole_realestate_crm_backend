const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { auth, authorize, checkModulePermission } = require('../middleware/auth');
const paymentService = require('../services/paymentService');
const Payment = require('../models/Payment');
const Transaction = require('../models/Transaction');
const Lead = require('../models/Lead');

// @route   POST /api/payments/create-order
// @desc    Create payment order (Razorpay/Stripe)
// @access  Private
router.post('/create-order',
  auth,
  checkModulePermission('leads', 'edit'),
  [
    body('amount').isNumeric().withMessage('Amount is required'),
    body('currency').optional().isString(),
    body('gateway').isIn(['razorpay', 'stripe']).withMessage('Valid gateway is required'),
    body('transactionId').isMongoId().withMessage('Valid transaction ID is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { amount, currency, gateway, transactionId, metadata } = req.body;

      // Verify transaction exists
      const transaction = await Transaction.findById(transactionId);
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      let orderData = null;

      if (gateway === 'razorpay') {
        orderData = await paymentService.createRazorpayOrder(
          amount,
          currency || 'INR',
          { transactionId, ...metadata }
        );
      } else if (gateway === 'stripe') {
        orderData = await paymentService.createStripePaymentIntent(
          amount,
          currency || 'usd',
          { transactionId, ...metadata }
        );
      }

      // Create payment record
      const payment = await paymentService.createPayment({
        transaction: transactionId,
        lead: transaction.lead,
        property: transaction.property,
        agency: transaction.agency,
        amount: amount,
        currency: currency || (gateway === 'razorpay' ? 'INR' : 'USD'),
        paymentMethod: gateway,
        gateway: gateway,
        gatewayOrderId: orderData.id,
        status: 'pending',
        createdBy: req.user.id
      });

      res.json({
        paymentId: payment._id,
        order: orderData,
        gateway: gateway
      });
    } catch (error) {
      console.error('Payment order creation error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });

// @route   POST /api/payments/verify
// @desc    Verify payment (Razorpay/Stripe)
// @access  Private
router.post('/verify',
  auth,
  checkModulePermission('leads', 'edit'),
  [
    body('paymentId').isMongoId().withMessage('Valid payment ID is required'),
    body('gateway').isIn(['razorpay', 'stripe']).withMessage('Valid gateway is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { paymentId, gateway, razorpayData, stripeData } = req.body;

      const payment = await Payment.findById(paymentId);
      if (!payment) {
        return res.status(404).json({ message: 'Payment not found' });
      }

      let verified = false;
      let gatewayPaymentId = null;

      if (gateway === 'razorpay' && razorpayData) {
        const { orderId, paymentId: razorpayPaymentId, signature } = razorpayData;
        verified = paymentService.verifyRazorpaySignature(orderId, razorpayPaymentId, signature);
        gatewayPaymentId = razorpayPaymentId;
      } else if (gateway === 'stripe' && stripeData) {
        const { paymentIntentId } = stripeData;
        const paymentIntent = await paymentService.verifyStripePayment(paymentIntentId);
        verified = paymentIntent.status === 'succeeded';
        gatewayPaymentId = paymentIntentId;
      }

      if (verified) {
        await paymentService.updatePaymentStatus(paymentId, 'completed', {
          paymentId: gatewayPaymentId,
          orderId: payment.gatewayOrderId,
          signature: razorpayData?.signature
        });

        const updatedPayment = await Payment.findById(paymentId)
          .populate('transaction')
          .populate('lead')
          .populate('property');

        res.json({
          success: true,
          payment: updatedPayment,
          message: 'Payment verified successfully'
        });
      } else {
        await paymentService.updatePaymentStatus(paymentId, 'failed');
        res.status(400).json({ message: 'Payment verification failed' });
      }
    } catch (error) {
      console.error('Payment verification error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });

// @route   POST /api/payments/webhook/razorpay
// @desc    Razorpay webhook handler
// @access  Public (with webhook secret)
router.post('/webhook/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (webhookSecret) {
      const generatedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (generatedSignature !== signature) {
        return res.status(400).json({ message: 'Invalid signature' });
      }
    }

    const event = req.body;
    const payment = await Payment.findOne({ gatewayPaymentId: event.payload.payment.entity.id });

    if (payment) {
      if (event.event === 'payment.captured') {
        await paymentService.updatePaymentStatus(payment._id, 'completed', {
          paymentId: event.payload.payment.entity.id
        });
      } else if (event.event === 'payment.failed') {
        await paymentService.updatePaymentStatus(payment._id, 'failed');
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Razorpay webhook error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/payments/webhook/stripe
// @desc    Stripe webhook handler
// @access  Public (with webhook secret)
router.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      return res.status(400).json({ message: `Webhook signature verification failed: ${err.message}` });
    }

    const payment = await Payment.findOne({ gatewayPaymentId: event.data.object.id });

    if (payment) {
      if (event.type === 'payment_intent.succeeded') {
        await paymentService.updatePaymentStatus(payment._id, 'completed', {
          paymentId: event.data.object.id
        });
      } else if (event.type === 'payment_intent.payment_failed') {
        await paymentService.updatePaymentStatus(payment._id, 'failed');
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/payments/:id/refund
// @desc    Process refund
// @access  Private (Super Admin, Agency Admin)
router.post('/:id/refund',
  auth,
  checkModulePermission('leads', 'edit'),
  [
    body('amount').isNumeric().withMessage('Amount is required'),
    body('reason').optional().isString()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { amount, reason } = req.body;
      const payment = await paymentService.processRefund(req.params.id, amount, reason);

      res.json({
        success: true,
        payment: payment,
        message: 'Refund processed successfully'
      });
    } catch (error) {
      console.error('Refund error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  });

// @route   GET /api/payments
// @desc    Get all payments
// @access  Private
router.get('/', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const { status, gateway, startDate, endDate, agency } = req.query;
    const query = {};

    if (status) query.status = status;
    if (gateway) query.gateway = gateway;
    if (agency) query.agency = agency;

    if (startDate || endDate) {
      query.paymentDate = {};
      if (startDate) query.paymentDate.$gte = new Date(startDate);
      if (endDate) query.paymentDate.$lte = new Date(endDate);
    }

    // Role-based filtering
    if (req.user.role === 'agency_admin') {
      query.agency = req.user.agency;
    } else if (req.user.role === 'agent') {
      query.createdBy = req.user.id;
    }

    const payments = await Payment.find(query)
      .populate('transaction')
      .populate('lead', 'contact leadId status')
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('createdBy', 'firstName lastName')
      .sort({ paymentDate: -1 })
      .limit(100);

    res.json(payments);
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/payments/:id
// @desc    Get payment by ID
// @access  Private
router.get('/:id', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('transaction')
      .populate('lead')
      .populate('property')
      .populate('agency')
      .populate('createdBy');

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin' && payment.agency.toString() !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(payment);
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/payments/:id/receipt
// @desc    Get payment receipt
// @access  Private
router.get('/:id/receipt', auth, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id).populate('lead');

    if (!payment) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    // Permission check: Admin/Agent or the Customer who owns the payment
    const isOwner = payment.lead?.contact?.email === req.user.email;
    const isAgencyAdmin = req.user.role === 'agency_admin' && payment.agency.toString() === req.user.agency;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgent = req.user.role === 'agent' && payment.createdBy.toString() === req.user.id;

    if (!isOwner && !isAgencyAdmin && !isSuperAdmin && !isAgent) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const doc = await paymentService.generateReceiptPDF(req.params.id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipt-${payment.receipt?.number || req.params.id}.pdf`);

    doc.pipe(res);
  } catch (error) {
    console.error('Get receipt error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

