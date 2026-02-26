const express = require('express');
const { body, validationResult, param } = require('express-validator');
const Watchlist = require('../models/Watchlist');
const Property = require('../models/Property');
const { auth } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/watchlist
// @desc    Get user's watchlist
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const watchlist = await Watchlist.find({ user: req.user.id })
      .populate({
        path: 'property',
        select: 'title slug price location specifications images status',
        populate: [
          { path: 'agency', select: 'name logo' },
          { path: 'agent', select: 'firstName lastName' }
        ]
      })
      .sort({ createdAt: -1 });

    res.json({ watchlist });
  } catch (error) {
    console.error('Get watchlist error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/watchlist
// @desc    Add property to watchlist
// @access  Private
router.post('/', [
  auth,
  body('property').isMongoId().withMessage('Valid property ID is required')
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

    // Check if already in watchlist
    const existing = await Watchlist.findOne({
      user: req.user.id,
      property: req.body.property
    });

    if (existing) {
      return res.status(400).json({ message: 'Property already in watchlist' });
    }

    const watchlistItem = new Watchlist({
      user: req.user.id,
      property: req.body.property,
      notes: req.body.notes
    });

    await watchlistItem.save();

    const populated = await Watchlist.findById(watchlistItem._id)
      .populate({
        path: 'property',
        select: 'title slug price location specifications images status',
        populate: [
          { path: 'agency', select: 'name logo' },
          { path: 'agent', select: 'firstName lastName' }
        ]
      });

    res.status(201).json({ watchlistItem: populated });
  } catch (error) {
    console.error('Add to watchlist error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Property already in watchlist' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/watchlist/:id
// @desc    Remove property from watchlist
// @access  Private
router.delete('/:id', auth, [
  param('id').isMongoId().withMessage('Invalid watchlist item ID')
], async (req, res) => {
  try {
    const watchlistItem = await Watchlist.findById(req.params.id);
    if (!watchlistItem) {
      return res.status(404).json({ message: 'Watchlist item not found' });
    }

    if (watchlistItem.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await Watchlist.deleteOne({ _id: req.params.id });
    res.json({ message: 'Property removed from watchlist' });
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/watchlist/property/:propertyId
// @desc    Remove property from watchlist by property ID
// @access  Private
router.delete('/property/:propertyId', auth, [
  param('propertyId').isMongoId().withMessage('Invalid property ID')
], async (req, res) => {
  try {
    const result = await Watchlist.deleteOne({
      user: req.user.id,
      property: req.params.propertyId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Property not found in watchlist' });
    }

    res.json({ message: 'Property removed from watchlist' });
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

