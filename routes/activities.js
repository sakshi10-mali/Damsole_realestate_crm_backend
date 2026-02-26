const express = require('express');
const { query, param } = require('express-validator');
const Activity = require('../models/Activity');
const { auth, authorize } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/activities
// @desc    Get activities
// @access  Private
router.get('/', auth, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 2000 }),
  query('entityType').optional(),
  query('entityId').optional(),
  query('type').optional(),
  query('agency').optional().isMongoId()
], async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const filter = {};

    // Role-based filtering
    if (req.user.role === 'agency_admin') {
      filter.agency = req.user.agency;
    } else if (req.user.role === 'agent') {
      filter.$or = [
        { performedBy: req.user.id },
        { relatedUsers: req.user.id }
      ];
    }

    if (req.query.entityType) filter.entityType = req.query.entityType;
    if (req.query.entityId) filter.entityId = req.query.entityId;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.agency) filter.agency = req.query.agency;

    const activities = await Activity.find(filter)
      .populate('performedBy', 'firstName lastName email profileImage')
      .populate('relatedUsers', 'firstName lastName')
      .populate('agency', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Activity.countDocuments(filter);

    res.json({
      activities,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get activities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/activities/entity/:entityType/:entityId
// @desc    Get activities for specific entity
// @access  Private
router.get('/entity/:entityType/:entityId', auth, [
  param('entityType').isIn(['lead', 'property', 'user', 'transaction', 'agency']),
  param('entityId').isMongoId().withMessage('Invalid entity ID')
], async (req, res) => {
  try {
    const activities = await Activity.find({
      entityType: req.params.entityType,
      entityId: req.params.entityId
    })
      .populate('performedBy', 'firstName lastName email profileImage')
      .populate('relatedUsers', 'firstName lastName')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ activities });
  } catch (error) {
    console.error('Get entity activities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

