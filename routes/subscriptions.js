const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { auth, checkModulePermission, optionalAuth } = require('../middleware/auth');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const User = require('../models/User');
const paymentService = require('../services/paymentService');

// GET /api/subscriptions/plans
router.get('/plans', async (req, res) => {
  try {
    const { search, interval, isActive, price_min, price_max } = req.query;
    const q = {};

    if (isActive !== undefined) q.isActive = isActive === 'true';
    if (interval) q.interval = interval;
    if (price_min || price_max) {
      q.price = {};
      if (price_min) q.price.$gte = Number(price_min);
      if (price_max) q.price.$lte = Number(price_max);
    }
    if (search) {
      q.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const plans = await Plan.find(q).sort({ price: 1 });
    res.json({ plans });
  } catch (error) {
    console.error('Get plans error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/subscriptions/plans
router.post('/plans',
  auth,
  checkModulePermission('subscriptions', 'create'),
  [
    body('name').notEmpty().withMessage('Name is required'),
    body('price').optional().isNumeric()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { name, description, price, interval, features, isActive, validity_days } = req.body;
      const plan = new Plan({
        plan_name: name, // Set plan_name from name
        name,
        description,
        price: price || 0,
        interval: interval || 'monthly',
        features: features || [],
        isActive: isActive !== false,
        validity_days: validity_days || 0,
        createdBy: req.user.id
      });
      await plan.save();
      res.json({ plan });
    } catch (error) {
      console.error('Create plan error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// GET /api/subscriptions/plans/:id
router.get('/plans/:id', auth, checkModulePermission('subscriptions', 'view'), async (req, res) => {
  try {
    const plan = await Plan.findById(req.params.id);
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    res.json({ plan });
  } catch (error) {
    console.error('Get plan error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// PATCH /api/subscriptions/plans/:id
router.patch('/plans/:id',
  auth,
  checkModulePermission('subscriptions', 'edit'),
  async (req, res) => {
    try {
      const updates = req.body;
      const plan = await Plan.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!plan) return res.status(404).json({ message: 'Plan not found' });
      res.json({ plan });
    } catch (error) {
      console.error('Update plan error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// PUT /api/subscriptions/plans/:id
// Support clients that send PUT when updating entire resource
router.put('/plans/:id',
  auth,
  checkModulePermission('subscriptions', 'edit'),
  async (req, res) => {
    try {
      const updates = req.body;
      const plan = await Plan.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!plan) return res.status(404).json({ message: 'Plan not found' });
      res.json({ plan });
    } catch (error) {
      console.error('Replace plan error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// DELETE /api/subscriptions/plans/:id
router.delete('/plans/:id',
  auth,
  checkModulePermission('subscriptions', 'delete'),
  async (req, res) => {
    try {
      const plan = await Plan.findByIdAndDelete(req.params.id);
      if (!plan) return res.status(404).json({ message: 'Plan not found' });
      res.json({ message: 'Deleted' });
    } catch (error) {
      console.error('Delete plan error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// GET /api/subscriptions - list subscriptions (admin view)
router.get('/', auth, checkModulePermission('subscriptions', 'view'), async (req, res) => {
  try {
    const { user: userId, plan_id, isActive, search, start_date, end_date, price_min, price_max } = req.query;
    const q = {};

    if (userId) q.user = userId;
    if (plan_id) q.plan = plan_id;
    if (isActive !== undefined) q.isActive = isActive === 'true';

    // Role-based filtering (Optional: can be re-added if agency is added to Subscription model)
    // if (req.user.role === 'agency_admin') q.agency = req.user.agency;

    // Date range
    if (start_date || end_date) {
      q.startedAt = {};
      if (start_date) q.startedAt.$gte = new Date(start_date);
      if (end_date) q.startedAt.$lte = new Date(end_date);
    }

    // Price range (requires join/populate or aggregation if price is on Plan)
    // For now, let's keep it simple or use aggregation if needed.
    // Since price is on Plan model, we might need to filter after populate or use lookup

    let subs = await Subscription.find(q)
      .populate('user', 'firstName lastName email profileImage')
      .populate('plan')
      .sort({ createdAt: -1 });

    // Client-side filtering for price and search if needed, but search can be optimized
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      subs = subs.filter(s =>
        (s.user && (s.user.firstName?.match(searchRegex) || s.user.lastName?.match(searchRegex) || s.user.email?.match(searchRegex))) ||
        (s.planName && s.planName.match(searchRegex)) ||
        (s.plan && (s.plan.plan_name?.match(searchRegex) || s.plan.name?.match(searchRegex)))
      );
    }

    if (price_min || price_max) {
      subs = subs.filter(s => {
        const price = s.plan?.price || 0;
        if (price_min && price < Number(price_min)) return false;
        if (price_max && price > Number(price_max)) return false;
        return true;
      });
    }

    res.json({ subscriptions: subs.slice(0, 500) });
  } catch (error) {
    console.error('List subscriptions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/subscriptions/:id
router.get('/:id', auth, checkModulePermission('subscriptions', 'view'), async (req, res) => {
  try {
    const sub = await Subscription.findById(req.params.id)
      .populate('user', 'firstName lastName email profileImage')
      .populate('plan');
    if (!sub) return res.status(404).json({ message: 'Subscription not found' });
    res.json({ subscription: sub });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/subscriptions/user/:id
router.get('/user/:id', auth, checkModulePermission('subscriptions', 'view'), async (req, res) => {
  try {
    const subs = await Subscription.find({ user: req.params.id })
      .populate('user', 'firstName lastName email profileImage')
      .populate('plan')
      .sort({ createdAt: -1 });
    res.json({ subscriptions: subs });
  } catch (error) {
    console.error('Get user subscriptions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/subscriptions/confirm
router.post('/confirm',
  auth,
  checkModulePermission('subscriptions', 'create'),
  [
    body('planId').notEmpty().withMessage('planId required'),
    body('provider').notEmpty().withMessage('provider required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { planId, provider, providerResponse } = req.body;
      const userId = req.user.id;

      const plan = planId ? await Plan.findById(planId) : null;

      let endedAt = null;
      if (plan && plan.validity_days) {
        endedAt = new Date();
        endedAt.setDate(endedAt.getDate() + plan.validity_days);
      }

      const sub = new Subscription({
        user: userId,
        plan: plan ? plan._id : undefined,
        planName: plan ? (plan.plan_name || plan.name) : (providerResponse?.planName || 'Unknown'),
        price: plan ? plan.price : (providerResponse?.amount / 100 || 0),
        provider,
        providerResponse: providerResponse || {},
        isActive: true,
        startedAt: new Date(),
        endedAt,
        createdBy: userId
      });
      await sub.save();

      // Populate before returning
      const populated = await Subscription.findById(sub._id).populate('user', 'firstName lastName email phone').populate('plan');

      // Send confirmation email
      try {
        const emailService = require('../services/emailService');
        await emailService.sendSubscriptionSuccessEmail(populated, populated.user, populated.plan);
      } catch (emailError) {
        console.error('Failed to send subscription confirmation email:', emailError);
      }

      res.json({ success: true, subscription: populated });
    } catch (error) {
      console.error('Confirm subscription error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// POST /api/subscriptions/create-order
// Creates a Razorpay order for the selected plan (amount taken from plan.price)
router.post('/create-order',
  auth,
  checkModulePermission('subscriptions', 'create'),
  [
    body('planId').notEmpty().withMessage('planId required'),
    body('currency').optional().isString()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
      const { planId, currency } = req.body;
      const plan = await Plan.findById(planId);
      if (!plan) return res.status(404).json({ message: 'Plan not found' });

      const amount = plan.price || 0;
      // Create razorpay order using paymentService
      const order = await paymentService.createRazorpayOrder(amount, currency || 'INR', { planId, userId: req.user.id });

      res.json({
        order,
        key: process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY
      });
    } catch (error) {
      console.error('Create order error:', error);
      res.status(500).json({ message: 'Server error', error: error.message });
    }
  }
);

// PATCH /api/subscriptions/:id - update subscription (e.g., toggle isActive)
router.patch('/:id',
  auth,
  checkModulePermission('subscriptions', 'edit'),
  async (req, res) => {
    try {
      const updates = req.body;
      const sub = await Subscription.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!sub) return res.status(404).json({ message: 'Subscription not found' });
      const populated = await Subscription.findById(sub._id)
        .populate('user', 'firstName lastName email profileImage')
        .populate('plan');
      res.json({ subscription: populated });
    } catch (error) {
      console.error('Update subscription error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// DELETE /api/subscriptions/:id - delete a subscription
router.delete('/:id',
  auth,
  checkModulePermission('subscriptions', 'delete'),
  async (req, res) => {
    try {
      const sub = await Subscription.findByIdAndDelete(req.params.id);
      if (!sub) return res.status(404).json({ message: 'Subscription not found' });
      res.json({ message: 'Deleted' });
    } catch (error) {
      console.error('Delete subscription error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

module.exports = router;

