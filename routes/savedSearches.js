const express = require('express');
const { body, validationResult, param } = require('express-validator');
const SavedSearch = require('../models/SavedSearch');
const Property = require('../models/Property');
const { auth } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/saved-searches
// @desc    Get user's saved searches
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const searches = await SavedSearch.find({ 
      user: req.user.id,
      isActive: true
    }).sort({ createdAt: -1 });

    res.json({ searches });
  } catch (error) {
    console.error('Get saved searches error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/saved-searches
// @desc    Create saved search
// @access  Private
router.post('/', [
  auth,
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('searchCriteria').isObject().withMessage('Search criteria is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const searchData = {
      ...req.body,
      user: req.user.id
    };

    const savedSearch = new SavedSearch(searchData);
    await savedSearch.save();

    res.status(201).json({ savedSearch });
  } catch (error) {
    console.error('Create saved search error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/saved-searches/:id/matches
// @desc    Get matching properties for saved search
// @access  Private
router.get('/:id/matches', auth, [
  param('id').isMongoId().withMessage('Invalid search ID')
], async (req, res) => {
  try {
    const savedSearch = await SavedSearch.findById(req.params.id);
    if (!savedSearch) {
      return res.status(404).json({ message: 'Saved search not found' });
    }

    if (savedSearch.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Build property filter from search criteria
    const filter = { status: 'active' };
    const criteria = savedSearch.searchCriteria;

    if (criteria.propertyType && criteria.propertyType.length > 0) {
      filter.propertyType = { $in: criteria.propertyType };
    }
    if (criteria.listingType) filter.listingType = criteria.listingType;
    if (criteria.city) filter['location.city'] = new RegExp(criteria.city, 'i');
    if (criteria.state) filter['location.state'] = new RegExp(criteria.state, 'i');
    if (criteria.country) filter['location.country'] = new RegExp(criteria.country, 'i');
    if (criteria.bedrooms) filter['specifications.bedrooms'] = { $gte: criteria.bedrooms };
    if (criteria.bathrooms) filter['specifications.bathrooms'] = { $gte: criteria.bathrooms };
    if (criteria.minArea) filter['specifications.area.value'] = { $gte: criteria.minArea };
    if (criteria.maxArea) {
      filter['specifications.area.value'] = {
        ...filter['specifications.area.value'],
        $lte: criteria.maxArea
      };
    }
    if (criteria.amenities && criteria.amenities.length > 0) {
      filter.amenities = { $in: criteria.amenities };
    }

    const properties = await Property.find(filter)
      .populate('agency', 'name logo')
      .populate('agent', 'firstName lastName')
      .populate('amenities', 'name icon')
      .limit(50);

    // Update match count
    savedSearch.matchCount = properties.length;
    await savedSearch.save();

    res.json({ properties, matchCount: properties.length });
  } catch (error) {
    console.error('Get search matches error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/saved-searches/:id
// @desc    Update saved search
// @access  Private
router.put('/:id', auth, [
  param('id').isMongoId().withMessage('Invalid search ID')
], async (req, res) => {
  try {
    const savedSearch = await SavedSearch.findById(req.params.id);
    if (!savedSearch) {
      return res.status(404).json({ message: 'Saved search not found' });
    }

    if (savedSearch.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    Object.assign(savedSearch, req.body);
    await savedSearch.save();

    res.json({ savedSearch });
  } catch (error) {
    console.error('Update saved search error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/saved-searches/:id
// @desc    Delete saved search
// @access  Private
router.delete('/:id', auth, [
  param('id').isMongoId().withMessage('Invalid search ID')
], async (req, res) => {
  try {
    const savedSearch = await SavedSearch.findById(req.params.id);
    if (!savedSearch) {
      return res.status(404).json({ message: 'Saved search not found' });
    }

    if (savedSearch.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await SavedSearch.deleteOne({ _id: req.params.id });
    res.json({ message: 'Saved search deleted successfully' });
  } catch (error) {
    console.error('Delete saved search error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

