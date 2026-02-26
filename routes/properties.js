const express = require('express');
const { body, validationResult, query, param } = require('express-validator');
const mongoose = require('mongoose');
const Property = require('../models/Property');
const User = require('../models/User');
const Agency = require('../models/Agency');
const { auth, authorize, optionalAuth, checkModulePermission } = require('../middleware/auth');
const emailService = require('../services/emailService');
const Lead = require('../models/Lead');
const Transaction = require('../models/Transaction');

const router = express.Router();

router.get('/', optionalAuth, [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 2000 }),
  query('status').optional().custom(value => {
    const statuses = value.split(',').map(s => s.trim());
    const validStatuses = ['draft', 'pending', 'active', 'sold', 'rented', 'inactive', 'booked'];
    return statuses.every(s => validStatuses.includes(s));
  }),
  query('propertyType').optional(),
  query('listingType').optional().isIn(['sale', 'rent', 'both']),
  query('city').optional(),
  query('state').optional(),
  query('country').optional(),
  query('area').optional(),
  query('agency').optional(),
  query('category').optional(),
  query('amenities').optional(),
  query('minPrice').optional().isFloat({ min: 0 }),
  query('maxPrice').optional().isFloat({ min: 0 }),
  query('bedrooms').optional().isInt({ min: 0 }),
  query('bathrooms').optional().isInt({ min: 0 }),
  query('minArea').optional().isFloat({ min: 0 }),
  query('maxArea').optional().isFloat({ min: 0 }),
  query('featured').optional().isBoolean(),
  query('trending').optional().isBoolean(),
  query('balconies').optional().isInt({ min: 0 }),
  query('livingRoom').optional().isInt({ min: 0 }),
  query('unfurnished').optional().isInt({ min: 0 }),
  query('semiFurnished').optional().isInt({ min: 0 }),
  query('fullyFurnished').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const filter = {};

    // Role-based filtering - Strict isolation for management
    if (req.user && req.user.role !== 'super_admin' && req.user.role !== 'staff') {
      const uId = mongoose.Types.ObjectId.isValid(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : req.user.id;
      const aId = req.user.agency && mongoose.Types.ObjectId.isValid(req.user.agency) ? new mongoose.Types.ObjectId(req.user.agency) : req.user.agency;

      // Determine if this is a public search (only status='active' requested)
      const isPublicSearch = req.query.status === 'active';

      if (req.user.role === 'agency_admin' || req.user.role === 'staff') {
        const userRole = req.user.role;
        // For public search, allow seeing all. For management, restrict to their agency.
        if (!isPublicSearch) {
          filter.agency = aId;
          // Respect entry permission settings
          filter[`entryPermissions.${userRole}.view`] = { $ne: false };
        }
      } else if (req.user.role === 'agent') {
        // For public search, allow seeing all. For management, restrict to their own properties.
        if (!isPublicSearch) {
          filter.agency = aId;
          filter.$or = [
            { agent: uId },
            { createdBy: uId }
          ];
          // Respect entry permission settings
          filter['entryPermissions.agent.view'] = { $ne: false };
        }
      }
    }

    // Status filtering - query parameter takes precedence
    if (req.query.status && req.query.status.trim() !== '') {
      const statuses = req.query.status.split(',').map(s => s.trim());
      if (statuses.length > 1) {
        filter.status = { $in: statuses };
      } else {
        filter.status = statuses[0];
      }
    } else if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin' && req.user.role !== 'agent' && req.user.role !== 'staff')) {
      // For public users and customers, only show active properties by default
      filter.status = 'active';
    }
    // If user is authenticated and no status filter, show all statuses (no status filter applied)
    if (req.query.propertyType) {
      filter.propertyType = req.query.propertyType;
    }
    if (req.query.listingType) {
      filter.listingType = req.query.listingType;
    }
    // Location filters
    if (req.query.city) {
      filter['location.city'] = new RegExp(req.query.city, 'i');
    }
    if (req.query.state) {
      filter['location.state'] = new RegExp(req.query.state, 'i');
    }
    if (req.query.country) {
      filter['location.country'] = new RegExp(req.query.country, 'i');
    }
    if (req.query.area) {
      const areaConditions = [
        { 'location.address': new RegExp(req.query.area, 'i') },
        { 'location.neighborhood': new RegExp(req.query.area, 'i') },
        { 'location.landmark': new RegExp(req.query.area, 'i') }
      ];

      // If we already have $or from search, combine with $and
      if (filter.$or && filter.$or.length > 0) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: areaConditions });
      } else {
        filter.$or = areaConditions;
      }
    }

    // Agency filter
    if (req.query.agency) {
      filter.agency = req.query.agency;
    }

    // Category filter
    if (req.query.category) {
      const categoryId = req.query.category.trim();
      if (mongoose.Types.ObjectId.isValid(categoryId)) {
        filter.category = new mongoose.Types.ObjectId(categoryId);
      }
    }

    // Amenities filter (comma-separated list of amenity IDs)
    if (req.query.amenities) {
      const raw = req.query.amenities;
      const ids = raw
        .split(',')
        .map(id => id.trim())
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (ids.length > 0) {
        // Match properties that have at least one of the selected amenities
        filter.amenities = { $in: ids };
      }
    }

    // Price filters
    if (req.query.minPrice || req.query.maxPrice) {
      const minPrice = req.query.minPrice ? parseFloat(req.query.minPrice) : null;
      const maxPrice = req.query.maxPrice ? parseFloat(req.query.maxPrice) : null;
      const listingType = req.query.listingType;

      const priceConditions = [];

      // For sale properties or when listing type is not specified
      if (!listingType || listingType === 'sale' || listingType === 'both') {
        const salePriceFilter = {};
        if (minPrice !== null || maxPrice !== null) {
          salePriceFilter['price.sale'] = {};
          if (minPrice !== null) salePriceFilter['price.sale'].$gte = minPrice;
          if (maxPrice !== null) salePriceFilter['price.sale'].$lte = maxPrice;
          priceConditions.push(salePriceFilter);
        }
      }

      // For rent properties or when listing type is not specified
      if (!listingType || listingType === 'rent' || listingType === 'both') {
        const rentPriceFilter = {};
        if (minPrice !== null || maxPrice !== null) {
          rentPriceFilter['price.rent.amount'] = {};
          if (minPrice !== null) rentPriceFilter['price.rent.amount'].$gte = minPrice;
          if (maxPrice !== null) rentPriceFilter['price.rent.amount'].$lte = maxPrice;
          priceConditions.push(rentPriceFilter);
        }
      }

      if (priceConditions.length > 0) {
        if (priceConditions.length === 1) {
          // Single condition - merge directly into filter
          Object.assign(filter, priceConditions[0]);
        } else {
          // Multiple conditions - use $or
          if (!filter.$or) {
            filter.$or = [];
          }
          // If there's already an $or from search, we need to use $and
          if (filter.$or.length > 0) {
            filter.$and = filter.$and || [];
            filter.$and.push({ $or: priceConditions });
          } else {
            filter.$or = priceConditions;
          }
        }
      }
    }

    // Specification filters
    if (req.query.bedrooms) {
      filter['specifications.bedrooms'] = parseInt(req.query.bedrooms);
    }
    if (req.query.bathrooms) {
      filter['specifications.bathrooms'] = parseInt(req.query.bathrooms);
    }
    if (req.query.balconies) {
      filter['specifications.balconies'] = parseInt(req.query.balconies);
    }
    if (req.query.livingRoom) {
      filter['specifications.livingRoom'] = parseInt(req.query.livingRoom);
    }
    if (req.query.unfurnished) {
      filter['specifications.unfurnished'] = parseInt(req.query.unfurnished);
    }
    if (req.query.semiFurnished) {
      filter['specifications.semiFurnished'] = parseInt(req.query.semiFurnished);
    }
    if (req.query.fullyFurnished) {
      filter['specifications.fullyFurnished'] = parseInt(req.query.fullyFurnished);
    }
    if (req.query.minArea || req.query.maxArea) {
      const areaFilter = {};
      if (req.query.minArea) {
        areaFilter['specifications.area.value'] = { $gte: parseFloat(req.query.minArea) };
      }
      if (req.query.maxArea) {
        if (areaFilter['specifications.area.value']) {
          areaFilter['specifications.area.value'].$lte = parseFloat(req.query.maxArea);
        } else {
          areaFilter['specifications.area.value'] = { $lte: parseFloat(req.query.maxArea) };
        }
      }
      filter.$and = filter.$and || [];
      filter.$and.push(areaFilter);
    }

    if (req.query.featured !== undefined) {
      filter.featured = req.query.featured === 'true';
    }
    if (req.query.trending !== undefined) {
      filter.trending = req.query.trending === 'true';
    }

    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      const searchRegex = new RegExp(searchTerm, 'i');

      const searchConditions = [
        { title: searchRegex },
        { description: searchRegex },
        { tags: searchRegex },
        { propertyType: searchRegex },
        { listingType: searchRegex },
        { status: searchRegex },
        { 'location.address': searchRegex },
        { 'location.city': searchRegex },
        { 'location.state': searchRegex },
        { 'location.country': searchRegex },
        { 'location.neighborhood': searchRegex },
        { 'location.landmark': searchRegex },
        { 'location.zipCode': searchRegex }
      ];

      // Search by agency name - find agencies matching the search term
      try {
        const matchingAgencies = await Agency.find({
          name: searchRegex
        }).select('_id');

        if (matchingAgencies.length > 0) {
          const agencyIds = matchingAgencies.map(agency => agency._id);
          searchConditions.push({ agency: { $in: agencyIds } });
        }
      } catch (error) {
        console.error('Error searching agencies:', error);
        // Continue with other search conditions even if agency search fails
      }

      // Also search in price fields if search term is numeric
      if (!isNaN(searchTerm) && searchTerm !== '') {
        const numericValue = parseFloat(searchTerm);
        searchConditions.push(
          { 'price.sale': numericValue },
          { 'price.rent.amount': numericValue },
          { 'specifications.bedrooms': numericValue },
          { 'specifications.bathrooms': numericValue },
          { 'specifications.balconies': numericValue },
          { 'specifications.livingRoom': numericValue },
          { 'specifications.unfurnished': numericValue },
          { 'specifications.semiFurnished': numericValue },
          { 'specifications.fullyFurnished': numericValue },
          { 'specifications.area.value': numericValue }
        );
      }

      // If we already have $or from price filters or area filter, combine with $and
      if (filter.$or && filter.$or.length > 0) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: searchConditions });
      } else {
        filter.$or = searchConditions;
      }
    }

    let properties = await Property.find(filter)
      .populate('agency', 'name logo')
      .populate('agent', 'firstName lastName email phone')
      .populate('category', 'name')
      .populate('amenities', 'name icon')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Property.countDocuments(filter);

    // When user is logged in, attach hasBooked for each property (customer can book only once per property)
    if (req.user && properties.length > 0) {
      const userLeads = await Lead.find({ 'contact.email': req.user.email }).select('_id');
      const leadIds = userLeads.map((l) => l._id);
      const bookedPropertyIds = new Set();
      if (leadIds.length > 0) {
        const txns = await Transaction.find({
          lead: { $in: leadIds },
          status: { $in: ['pending', 'completed'] }
        }).select('property');
        txns.forEach((t) => {
          if (t.property) bookedPropertyIds.add(t.property.toString());
        });
      }
      properties = properties.map((p) => {
        const po = p.toObject ? p.toObject() : { ...p };
        if (bookedPropertyIds.has((po._id || p._id).toString())) po.hasBooked = true;
        return po;
      });
    }

    res.json({
      properties,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get properties error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Helper function to check if string is a valid MongoDB ObjectId
const isValidObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(id) && (String)(new mongoose.Types.ObjectId(id)) === id;
};

// @route   GET /api/properties/:id/leads
// @desc    Get property leads (must be before /:id route)
// @access  Private
router.get('/:id/leads', auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    const Lead = require('../models/Lead');
    const leads = await Lead.find({ property: req.params.id })
      .populate('assignedAgent', 'firstName lastName email')
      .populate('agency', 'name')
      .populate('contact', 'firstName lastName email phone')
      .sort({ createdAt: -1 });

    res.json({ leads, total: leads.length });
  } catch (error) {
    console.error('Get property leads error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/properties/:id/notes
// @desc    Add note to property (must be before /:id route)
// @access  Private
router.post('/:id/notes', [
  auth,
  checkModulePermission('properties', 'edit'),
  body('note').trim().notEmpty().withMessage('Note is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Check permissions
    const propertyAgencyId = property.agency ? property.agency.toString() : null;
    const propertyAgentId = property.agent ? property.agent.toString() : null;

    if (req.user.role === 'agency_admin' && propertyAgencyId && propertyAgencyId !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }
    if (req.user.role === 'agent' && propertyAgentId && propertyAgentId !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    property.notes.push({
      note: req.body.note,
      createdBy: req.user.id
    });

    await property.save();

    const updatedProperty = await Property.findById(property._id)
      .populate('agency', 'name logo')
      .populate('agent', 'firstName lastName email phone')
      .populate('category', 'name')
      .populate('amenities', 'name icon')
      .populate('notes.createdBy', 'firstName lastName email');

    res.json({ property: updatedProperty });
  } catch (error) {
    console.error('Add property note error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/properties/:id/assign
// @desc    Reassign property to agent (must be before /:id route)
// @access  Private (Super Admin, Agency Admin)
router.put('/:id/assign', [
  auth,
  checkModulePermission('properties', 'edit'),
  param('id').isMongoId().withMessage('Invalid property ID'),
  body('agent').isMongoId().withMessage('Valid agent ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Check permissions
    const propertyAgencyId = property.agency ? property.agency.toString() : null;

    if (req.user.role === 'agency_admin' && propertyAgencyId && propertyAgencyId !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied' });
    }

    // Validate agent
    const agent = await User.findById(req.body.agent);
    if (!agent || agent.role !== 'agent') {
      return res.status(404).json({ message: 'Agent not found' });
    }

    if (!agent.isActive) {
      return res.status(400).json({ message: 'Agent account is not active' });
    }

    // Check if agent belongs to the same agency as property
    const agentAgencyId = agent.agency ? agent.agency.toString() : null;
    if (propertyAgencyId && agentAgencyId && propertyAgencyId !== agentAgencyId) {
      return res.status(400).json({ message: 'Agent does not belong to the property agency' });
    }

    // Reassign property
    property.agent = req.body.agent;
    await property.save();

    const updatedProperty = await Property.findById(property._id)
      .populate('agency', 'name logo contact')
      .populate('agent', 'firstName lastName email phone profileImage')
      .populate('category', 'name')
      .populate('amenities', 'name icon');
    res.json({
      message: 'Property reassigned successfully',
      property: updatedProperty
    });
  } catch (error) {
    console.error('Reassign property error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/properties/my-properties
// @desc    Get properties for current customer (inquired, purchased, rented)
// @access  Private
router.get('/my-properties', auth, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const Lead = require('../models/Lead');
    // Ensure Transaction model is registered
    let Transaction;
    try {
      Transaction = mongoose.model('Transaction');
    } catch (e) {
      Transaction = require('../models/Transaction');
    }

    // 1. Inquired properties
    const inquiries = await Lead.find({ 'contact.email': userEmail })
      .populate({
        path: 'property',
        populate: [
          { path: 'agency', select: 'name logo' },
          { path: 'agent', select: 'firstName lastName email' }
        ]
      })
      .sort({ createdAt: -1 });

    // 2. Purchased/Rented properties via transactions
    const customerLeadsIds = await Lead.find({ 'contact.email': userEmail }).distinct('_id');
    const transactions = await Transaction.find({
      lead: { $in: customerLeadsIds }
    }).populate({
      path: 'property',
      populate: [
        { path: 'agency', select: 'name logo' },
        { path: 'agent', select: 'firstName lastName email' }
      ]
    });

    const purchased = transactions.filter(t => t.type === 'sale' && t.status === 'completed').map(t => t.property);
    const rented = transactions.filter(t => t.type === 'rent' && t.status === 'completed').map(t => t.property);
    const booked = transactions.filter(t => t.status === 'pending').map(t => t.property);

    res.json({
      inquired: inquiries.map(i => i.property).filter(Boolean),
      purchased: purchased.filter(Boolean),
      rented: rented.filter(Boolean),
      booked: booked.filter(Boolean)
    });
  } catch (error) {
    console.error('Get my properties error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const identifier = req.params.id;
    let property;

    // Check if identifier is a MongoDB ObjectId or a slug
    if (isValidObjectId(identifier)) {
      // It's an ObjectId, search by _id
      property = await Property.findById(identifier)
        .populate('agency', 'name logo contact')
        .populate('agent', 'firstName lastName email phone profileImage')
        .populate('category', 'name')
        .populate('amenities', 'name icon');
    } else {
      // It's a slug, search by slug
      property = await Property.findOne({ slug: identifier })
        .populate('agency', 'name logo contact')
        .populate('agent', 'firstName lastName email phone profileImage')
        .populate('category', 'name')
        .populate('amenities', 'name icon');
    }

    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Handle access control with proper null checks
    if (!req.user) {
      if (property.status !== 'active') {
        return res.status(403).json({ message: 'Property not available' });
      }
    } else if (req.user.role !== 'super_admin') {
      // If it's an active property, allow any logged-in user to see it (Public View)
      if (property.status === 'active') {
        // Continue
      } else {
        // Strict isolation for non-active properties
        const propertyAgencyId = property.agency
          ? (typeof property.agency === 'object' && property.agency._id
            ? property.agency._id.toString()
            : property.agency.toString())
          : null;

        const propertyAgentId = property.agent
          ? (typeof property.agent === 'object' && property.agent._id
            ? property.agent._id.toString()
            : property.agent.toString())
          : null;

        const creatorId = property.createdBy?.toString();

        if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && propertyAgencyId && propertyAgencyId !== req.user.agency) {
          return res.status(403).json({ message: 'Access denied' });
        }
        if (req.user.role === 'agent') {
          if (propertyAgentId !== req.user.id && creatorId !== req.user.id) {
            return res.status(403).json({ message: 'Access denied' });
          }
        }
      }
    }

    // Safely increment viewCount
    if (typeof property.viewCount !== 'number') {
      property.viewCount = 0;
    }
    property.viewCount += 1;
    await property.save();

    // Check if current user has booked this property or has it in watchlist
    if (req.user) {
      // Check booking status (user may have multiple leads or interestedProperties)
      const userLeads = await Lead.find({ 'contact.email': req.user.email }).select('_id');
      const leadIds = userLeads.map((l) => l._id);
      if (leadIds.length > 0) {
        const transaction = await Transaction.findOne({
          property: property._id,
          lead: { $in: leadIds },
          status: { $in: ['pending', 'completed'] }
        });
        if (transaction) {
          property = property.toObject ? property.toObject() : { ...property };
          property.hasBooked = true;
          property.bookingStatus = transaction.status;
        }
      }

      // Check watchlist status
      const Watchlist = require('../models/Watchlist');
      const watchlistItem = await Watchlist.findOne({
        user: req.user.id,
        property: property._id
      });

      if (watchlistItem) {
        if (!property.hasBooked && !property.inWishlist) property = property.toObject ? property.toObject() : { ...property };
        property.inWishlist = true;
      }
    }

    res.json({ property });
  } catch (error) {
    console.error('Get property error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.get('/slug/:slug', optionalAuth, async (req, res) => {
  try {
    const property = await Property.findOne({ slug: req.params.slug })
      .populate('agency', 'name logo contact')
      .populate('agent', 'firstName lastName email phone profileImage')
      .populate('category', 'name')
      .populate('amenities', 'name icon');

    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Handle access control with proper null checks
    if (!req.user) {
      if (property.status !== 'active') {
        return res.status(403).json({ message: 'Property not available' });
      }
    } else if (req.user.role !== 'super_admin') {
      // If it's an active property, allow viewing even if not assigned (Public View)
      if (property.status === 'active') {
        // Continue
      } else {
        // Strict isolation for non-active properties
        const propertyAgencyId = property.agency
          ? (typeof property.agency === 'object' && property.agency._id
            ? property.agency._id.toString()
            : property.agency.toString())
          : null;

        const propertyAgentId = property.agent
          ? (typeof property.agent === 'object' && property.agent._id
            ? property.agent._id.toString()
            : property.agent.toString())
          : null;

        const creatorId = property.createdBy?.toString();

        if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && propertyAgencyId && propertyAgencyId !== req.user.agency) {
          return res.status(403).json({ message: 'Access denied' });
        }
        if (req.user.role === 'agent') {
          if (propertyAgentId !== req.user.id && creatorId !== req.user.id) {
            return res.status(403).json({ message: 'Access denied' });
          }
        }
      }
    }

    // Safely increment viewCount
    if (typeof property.viewCount !== 'number') {
      property.viewCount = 0;
    }
    property.viewCount += 1;
    await property.save();

    // Check if current user has booked this property or has it in watchlist
    if (req.user) {
      // Check booking status (user may have multiple leads or interestedProperties)
      const userLeads = await Lead.find({ 'contact.email': req.user.email }).select('_id');
      const leadIds = userLeads.map((l) => l._id);
      if (leadIds.length > 0) {
        const transaction = await Transaction.findOne({
          property: property._id,
          lead: { $in: leadIds },
          status: { $in: ['pending', 'completed'] }
        });
        if (transaction) {
          property = property.toObject ? property.toObject() : { ...property };
          property.hasBooked = true;
          property.bookingStatus = transaction.status;
        }
      }

      // Check watchlist status
      const Watchlist = require('../models/Watchlist');
      const watchlistItem = await Watchlist.findOne({
        user: req.user.id,
        property: property._id
      });

      if (watchlistItem) {
        if (!property.hasBooked && !property.inWishlist) property = property.toObject ? property.toObject() : { ...property };
        property.inWishlist = true;
      }
    }

    res.json({ property });
  } catch (error) {
    console.error('Get property by slug error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/properties/:id/book
// @desc    Book a property from customer panel
// @access  Private (Customer)
router.post('/:id/book', auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id)
      .populate('agency')
      .populate('agent');
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    if (property.status !== 'active') {
      return res.status(400).json({ message: 'Property is not available for booking' });
    }

    // Prevent same customer from booking the same property more than once
    const userLeads = await Lead.find({ 'contact.email': req.user.email }).select('_id');
    const leadIds = userLeads.map((l) => l._id);
    if (leadIds.length > 0) {
      const alreadyBooked = await Transaction.findOne({
        property: req.params.id,
        lead: { $in: leadIds },
        status: { $in: ['pending', 'completed'] }
      });
      if (alreadyBooked) {
        return res.status(400).json({ message: 'You have already booked this property' });
      }
    }

    // Fetch full user details for correct name/phone in emails and leads
    const customerUser = await User.findById(req.user.id);
    if (!customerUser) {
      return res.status(404).json({ message: 'Customer account not found' });
    }

    // 1. Find or create a Lead for this customer
    // Consolidate leads by email to prevent duplicates in the lead panel
    let lead = await Lead.findOne({
      'contact.email': customerUser.email
    });

    if (lead) {
      // If lead exists, add this property to interestedProperties if not already there
      const alreadyInterested = lead.interestedProperties?.some(ip =>
        ip.property?.toString() === property._id?.toString()
      );

      if (!alreadyInterested) {
        lead.interestedProperties = lead.interestedProperties || [];
        lead.interestedProperties.push({
          property: property._id,
          action: 'booked',
          date: new Date()
        });
      }

      // Update main property to the latest one if needed, or keep original
      // The user wants one lead for multiple properties, so we maintain internal list
      await lead.save();
    } else {
      // Ensure phone is present as it's required by Lead schema
      const userPhone = customerUser.phone || '0000000000';
      lead = new Lead({
        property: property._id,
        interestedProperties: [{
          property: property._id,
          action: 'booked',
          date: new Date()
        }],
        agency: property.agency,
        assignedAgent: property.agent,
        contact: {
          firstName: customerUser.firstName || 'Customer',
          lastName: customerUser.lastName || 'User',
          email: customerUser.email,
          phone: userPhone
        },
        inquiry: {
          message: 'Property booked from customer portal'
        },
        status: 'new',
        source: 'website'
      });

      if (!lead.agency) {
        return res.status(400).json({ message: 'Property has no associated agency' });
      }

      await lead.save();
    }

    // 2. Determine Transaction Amount
    let transactionAmount = 0;
    if (property.listingType === 'rent') {
      transactionAmount = property.price?.rent?.amount || 0;
    } else {
      transactionAmount = property.price?.sale || 0;
    }

    if (!transactionAmount || transactionAmount <= 0) {
      return res.status(400).json({ message: 'Property price is not set correctly' });
    }

    // 3. Create a Transaction
    const transaction = new Transaction({
      property: property._id,
      lead: lead._id,
      agency: property.agency || lead.agency,
      agent: property.agent || lead.assignedAgent,
      type: property.listingType === 'rent' ? 'rent' : 'sale',
      amount: transactionAmount,
      status: 'pending',
      transactionDate: new Date(),
      paymentMethod: 'other',
      notes: 'Booked by customer',
      createdBy: req.user.id
    });

    // Ensure agency and agent are present as they are required by Transaction schema
    if (!transaction.agency || !transaction.agent) {
      return res.status(400).json({ message: 'Agency or Agent information missing on property' });
    }

    // Calculate commission (Default 2% if not specified)
    const commPerc = lead.inquiry?.commissionPercentage || 2;
    transaction.commission = {
      percentage: commPerc,
      amount: (transactionAmount * commPerc) / 100
    };

    await transaction.save();

    // 4. Update Property Status
    // Removed: Property status should remain 'active' until confirmed/completed
    // property.status = 'booked';
    // await property.save();

    // 5. Send Email Notifications (Customer, Agent, Agency)
    setImmediate(async () => {
      try {
        await emailService.sendBookingRequestNotification(
          property,
          customerUser,
          property.agent,
          property.agency
        );
      } catch (notifError) {
        console.error('Error sending booking notifications:', notifError);
      }
    });

    res.json({
      message: 'Property booked successfully',
      property,
      transaction
    });
  } catch (error) {
    console.error('Book property error:', error);
    // Return specific validation error if it exists
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        message: 'Validation failed',
        errors: Object.values(error.errors).map(err => err.message)
      });
    }
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

router.post('/', [
  auth,
  checkModulePermission('properties', 'create'),
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('description').trim().notEmpty().withMessage('Description is required'),
  body('propertyType').isIn(['apartment', 'house', 'villa', 'condo', 'townhouse', 'land', 'commercial', 'office', 'retail', 'warehouse', 'other']).withMessage('Invalid property type'),
  body('listingType').isIn(['sale', 'rent', 'both']).withMessage('Invalid listing type'),
  body('location.address').trim().notEmpty().withMessage('Address is required'),
  body('location.city').trim().notEmpty().withMessage('City is required'),
  body('location.state').trim().notEmpty().withMessage('State is required'),
  body('location.country').trim().notEmpty().withMessage('Country is required'),
  body('specifications.area.value').isNumeric().withMessage('Area value is required'),
  // agency and agent are optional - will be auto-populated from authenticated user
  body('agency').optional().isMongoId().withMessage('Valid agency ID is required'),
  body('agent').optional().isMongoId().withMessage('Valid agent ID is required')
], async (req, res) => {
  try {
    // Auto-populate agency and agent from authenticated user if not provided
    if (!req.body.agency) {
      if (req.user.role === 'agent' || req.user.role === 'agency_admin') {
        req.body.agency = req.user.agency;
      } else if (req.user.role === 'super_admin' && !req.body.agency) {
        return res.status(400).json({ message: 'Agency ID is required for super admin' });
      }
    }

    if (!req.body.agent) {
      if (req.user.role === 'agent') {
        req.body.agent = req.user.id;
      } else if (req.user.role === 'agency_admin' && !req.body.agent) {
        // Agency admin can create properties without specifying agent (optional)
        // But if they do specify, validate it
      }
    }

    // Now validate that agency and agent are present and valid
    if (!req.body.agency) {
      return res.status(400).json({ message: 'Agency ID is required' });
    }

    if (!req.body.agent && req.user.role === 'agent') {
      return res.status(400).json({ message: 'Agent ID is required' });
    }

    // Log the incoming request for debugging
    console.log('=== Property Creation Request ===');
    console.log('User:', {
      id: req.user.id,
      role: req.user.role,
      agency: req.user.agency
    });
    console.log('Request Body Keys:', Object.keys(req.body));
    console.log('Request Body:', {
      title: req.body.title,
      description: req.body.description ? 'Present' : 'Missing',
      propertyType: req.body.propertyType,
      listingType: req.body.listingType,
      agency: req.body.agency,
      agent: req.body.agent,
      location: req.body.location ? {
        address: req.body.location.address,
        city: req.body.location.city,
        state: req.body.location.state,
        country: req.body.location.country
      } : 'Missing',
      specifications: req.body.specifications ? {
        area: req.body.specifications.area
      } : 'Missing'
    });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('=== Validation Errors ===');
      console.error(JSON.stringify(errors.array(), null, 2));
      return res.status(400).json({ errors: errors.array() });
    }

    if (req.user.role === 'agency_admin' && req.body.agency !== req.user.agency) {
      return res.status(403).json({ message: 'You can only create properties for your agency' });
    }

    if (req.user.role === 'agent' && req.body.agent !== req.user.id) {
      return res.status(403).json({ message: 'You can only create properties assigned to yourself' });
    }

    const agency = await Agency.findById(req.body.agency);
    if (!agency) {
      return res.status(404).json({ message: 'Agency not found' });
    }

    // Validate agent only if provided (required for agents, optional for agency_admin)
    if (req.body.agent) {
      const agent = await User.findById(req.body.agent);
      if (!agent || agent.role !== 'agent') {
        return res.status(404).json({ message: 'Agent not found' });
      }
      if (!agent.isActive) {
        return res.status(400).json({ message: 'Agent account is not active. Please contact your agency admin.' });
      }
      if (agent.agency && agent.agency.toString() !== req.body.agency) {
        return res.status(400).json({ message: 'Agent does not belong to the specified agency' });
      }
      if (!agent.agency) {
        return res.status(400).json({ message: 'Agent is not associated with an agency. Please contact the administrator.' });
      }
    } else if (req.user.role === 'agent') {
      // Agent role must have agent ID (should have been auto-populated above)
      return res.status(400).json({ message: 'Agent ID is required' });
    }

    // Force status to pending for agents
    if (req.user.role === 'agent') {
      req.body.status = 'pending';
    }

    const property = new Property({
      ...req.body,
      createdBy: req.user.id,
      creatorRole: req.user.role
    });
    await property.save();

    const populatedProperty = await Property.findById(property._id)
      .populate('agency', 'name logo')
      .populate('agent', 'firstName lastName email phone')
      .populate('category', 'name')
      .populate('amenities', 'name icon');

    // Send notifications
    setImmediate(async () => {
      try {
        // 1. Notify Agency Admins (if creator is not an agency admin)
        if (req.user.role !== 'agency_admin') {
          // Find all active agency admins for this agency
          const agencyAdmins = await User.find({
            agency: populatedProperty.agency?._id || populatedProperty.agency,
            role: 'agency_admin',
            isActive: true
          }).select('email');

          const recipientEmails = agencyAdmins.map(admin => admin.email).filter(Boolean);

          if (recipientEmails.length > 0) {
            await emailService.sendNewPropertyNotificationToAdmin(
              populatedProperty,
              populatedProperty.agent || { firstName: 'Agent', lastName: '' },
              populatedProperty.agency,
              recipientEmails
            );
          }
        }

        // 2. Notify Assigned Agent (if creator is not the agent)
        if (req.user.role !== 'agent' && populatedProperty.agent) {
          // Check if agent is valid and has email
          if (populatedProperty.agent.email) {
            await emailService.sendNewPropertyNotificationToAgent(
              populatedProperty,
              populatedProperty.agent,
              populatedProperty.agency
            );
          }
        }
      } catch (notifError) {
        console.error('Error sending new property notifications:', notifError);
      }
    });

    res.status(201).json(populatedProperty);
  } catch (error) {
    console.error('Create property error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Property with this slug already exists' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/properties/:id/approve
// @desc    Approve or reject property (must be before /:id route)
// @access  Private (Super Admin, Agency Admin)
router.put('/:id/approve', [
  auth,
  checkModulePermission('properties', 'edit'),
  param('id').isMongoId().withMessage('Invalid property ID'),
  body('status').isIn(['active', 'inactive']).withMessage('Status must be active or inactive'),
  body('rejectionReason').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const property = await Property.findById(req.params.id)
      .populate('agent', 'firstName lastName email phone')
      .populate('agency', 'name');

    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin') {
      // Handle both populated object and ID string formats
      const propertyAgencyId = typeof property.agency === 'object' && property.agency._id
        ? property.agency._id.toString()
        : property.agency?.toString() || property.agency

      const userAgencyId = req.user.agency?.toString() || req.user.agency

      if (propertyAgencyId !== userAgencyId) {
        console.error('Agency mismatch:', {
          propertyAgencyId,
          userAgencyId,
          propertyAgency: property.agency,
          userAgency: req.user.agency
        })
        return res.status(403).json({ message: 'Access denied. You can only approve properties from your agency.' });
      }
    }

    const oldStatus = property.status;
    property.status = req.body.status;

    if (req.body.status === 'inactive' && req.body.rejectionReason) {
      property.rejectionReason = req.body.rejectionReason;
    } else if (req.body.status === 'active') {
      property.rejectionReason = undefined;
    }

    await property.save();

    // Send notification to agent in background
    setImmediate(async () => {
      try {
        if (property.agent && property.agent.email) {
          if (req.body.status === 'active') {
            await emailService.sendPropertyApprovalNotification(property, property.agent, property.agency);
          } else {
            await emailService.sendPropertyRejectionNotification(property, property.agent, property.agency, req.body.rejectionReason);
          }
        }
      } catch (notifError) {
        console.error('Error sending property approval notification:', notifError);
      }
    });

    const updatedProperty = await Property.findById(property._id)
      .populate('agency', 'name logo')
      .populate('agent', 'firstName lastName email phone')
      .populate('category', 'name')
      .populate('amenities', 'name icon');

    res.json({
      message: `Property ${req.body.status === 'active' ? 'approved' : 'rejected'} successfully`,
      property: updatedProperty
    });
  } catch (error) {
    console.error('Approve property error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', [
  auth,
  checkModulePermission('properties', 'edit'),
  param('id').isMongoId().withMessage('Invalid property ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Get agency ID safely (handle both ObjectId and null)
    const propertyAgencyId = property.agency ? property.agency.toString() : null;
    const propertyAgentId = property.agent ? property.agent.toString() : null;

    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && propertyAgencyId && propertyAgencyId !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied to this agency property' });
    }
    if (req.user.role === 'agent') {
      const creatorId = property.createdBy?.toString();
      if (propertyAgentId !== req.user.id && creatorId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. You can only edit your own assigned properties.' });
      }
    }

    // Creator-based permission restrictions
    if (property.creatorRole === 'agent') {
      // If property was created by an agent, agency_admin and super_admin cannot edit it
      if (req.user.role === 'agency_admin' || req.user.role === 'super_admin') {
        return res.status(403).json({ message: 'Access denied. Only the property creator (agent) can edit this property.' });
      }
    } else if (property.creatorRole === 'agency_admin') {
      // If property was created by an agency admin, super_admin cannot edit it
      if (req.user.role === 'super_admin') {
        return res.status(403).json({ message: 'Access denied. Only the agency admin who created this property can edit it.' });
      }
    }

    // Force status back to pending if edited by an agent to require re-approval
    if (req.user.role === 'agent') {
      req.body.status = 'pending';
    }

    // Capture old state for status change notifications
    const oldStatus = property.status;
    const newStatus = req.body.status;

    Object.assign(property, req.body);
    await property.save();

    const updatedProperty = await Property.findById(property._id)
      .populate('agency', 'name logo')
      .populate('agent', 'firstName lastName email phone')
      .populate('category', 'name')
      .populate('amenities', 'name icon');

    // Send notifications for Sold, Rented, Unavailable status updates
    const importantStatuses = ['sold', 'rented', 'unavailable', 'inactive'];
    if (newStatus && newStatus !== oldStatus && importantStatuses.includes(newStatus)) {
      setImmediate(async () => {
        try {
          // Get Agency Admins for this agency
          const agencyAdmins = await User.find({
            agency: updatedProperty.agency?._id || updatedProperty.agency,
            role: 'agency_admin',
            isActive: true
          }).select('email');

          const recipientEmails = new Set();

          // Add Agency Admins
          agencyAdmins.forEach(admin => recipientEmails.add(admin.email));

          // Add the concerned Agent
          if (updatedProperty.agent && updatedProperty.agent.email) {
            recipientEmails.add(updatedProperty.agent.email);
          }

          const recipientsArray = Array.from(recipientEmails).filter(Boolean);

          if (recipientsArray.length > 0) {
            await emailService.sendPropertyStatusUpdateNotification(
              updatedProperty,
              updatedProperty.agent,
              updatedProperty.agency,
              recipientsArray,
              newStatus
            );
          }
        } catch (notifError) {
          console.error('Error sending property status update notification:', notifError);
        }
      });
    }

    res.json(updatedProperty);
  } catch (error) {
    console.error('Update property error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Property with this slug already exists' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});


// @route   GET /api/properties/:id/inquiries
// @desc    Get property inquiry history
// @access  Private
router.get('/:id/inquiries', auth, async (req, res) => {
  try {
    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    const Lead = require('../models/Lead');
    const inquiries = await Lead.find({ property: req.params.id })
      .populate('assignedAgent', 'firstName lastName email')
      .populate('agency', 'name')
      .sort({ createdAt: -1 });

    res.json({ inquiries, total: inquiries.length });
  } catch (error) {
    console.error('Get property inquiries error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/properties/compare
// @desc    Compare multiple properties
// @access  Public
router.post('/compare', optionalAuth, [
  body('propertyIds').isArray().withMessage('Property IDs array is required'),
  body('propertyIds.*').isMongoId().withMessage('Invalid property ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { propertyIds } = req.body;

    if (propertyIds.length < 2 || propertyIds.length > 5) {
      return res.status(400).json({ message: 'Please select 2-5 properties to compare' });
    }

    const properties = await Property.find({
      _id: { $in: propertyIds },
      status: req.user ? undefined : 'active'
    })
      .populate('agency', 'name logo')
      .populate('agent', 'firstName lastName email phone')
      .populate('category', 'name')
      .populate('amenities', 'name icon');

    if (properties.length !== propertyIds.length) {
      return res.status(404).json({ message: 'Some properties not found' });
    }

    // Helper function to find common amenities
    const findCommonAmenities = (props) => {
      if (props.length === 0) return [];

      const amenityCounts = {};
      props.forEach(property => {
        if (property.amenities) {
          property.amenities.forEach(amenity => {
            const amenityId = amenity._id?.toString() || amenity.toString();
            amenityCounts[amenityId] = (amenityCounts[amenityId] || 0) + 1;
          });
        }
      });

      // Return amenities that appear in all properties
      const commonAmenityIds = Object.keys(amenityCounts).filter(
        id => amenityCounts[id] === props.length
      );

      // Get amenity details from first property
      if (props[0] && props[0].amenities) {
        return props[0].amenities.filter(amenity => {
          const amenityId = amenity._id?.toString() || amenity.toString();
          return commonAmenityIds.includes(amenityId);
        });
      }
      return [];
    };

    // Create comparison data
    const comparison = {
      properties: properties.map(p => ({
        _id: p._id,
        title: p.title,
        slug: p.slug,
        propertyType: p.propertyType,
        listingType: p.listingType,
        price: p.price,
        location: p.location,
        specifications: p.specifications,
        amenities: p.amenities,
        images: p.images,
        description: p.description,
        agent: p.agent,
        agency: p.agency
      })),
      comparison: {
        priceRange: {
          min: Math.min(...properties.map(p => p.price?.sale || p.price?.rent?.amount || 0)),
          max: Math.max(...properties.map(p => p.price?.sale || p.price?.rent?.amount || 0))
        },
        averageArea: properties.reduce((sum, p) => sum + (p.specifications?.area?.value || 0), 0) / properties.length,
        commonAmenities: findCommonAmenities(properties),
        propertyTypes: [...new Set(properties.map(p => p.propertyType))]
      }
    };

    res.json({ comparison });
  } catch (error) {
    console.error('Compare properties error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/properties/bulk
// @desc    Bulk update properties
// @access  Private (Super Admin, Agency Admin)
router.put('/bulk', [
  auth,
  checkModulePermission('properties', 'edit'),
  body('propertyIds').isArray().withMessage('Property IDs array is required'),
  body('propertyIds.*').isMongoId().withMessage('Invalid property ID'),
  body('updates').isObject().withMessage('Updates object is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { propertyIds, updates } = req.body;
    const filter = { _id: { $in: propertyIds } };

    // Agency admin can only update their agency's properties
    if (req.user.role === 'agency_admin') {
      filter.agency = req.user.agency;
    }

    const result = await Property.updateMany(filter, updates);

    res.json({
      message: `${result.modifiedCount} properties updated successfully`,
      modifiedCount: result.modifiedCount,
      matchedCount: result.matchedCount
    });
  } catch (error) {
    console.error('Bulk update properties error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/properties/bulk
// @desc    Bulk delete properties
// @access  Private (Super Admin, Agency Admin)
router.delete('/bulk', [
  auth,
  checkModulePermission('properties', 'delete'),
  body('propertyIds').isArray().withMessage('Property IDs array is required'),
  body('propertyIds.*').isMongoId().withMessage('Invalid property ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { propertyIds } = req.body;
    const filter = { _id: { $in: propertyIds } };

    // Agency admin can only delete their agency's properties
    if (req.user.role === 'agency_admin') {
      filter.agency = req.user.agency;
    }

    const result = await Property.deleteMany(filter);

    res.json({
      message: `${result.deletedCount} properties deleted successfully`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Bulk delete properties error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', [
  auth,
  checkModulePermission('properties', 'delete'),
  param('id').isMongoId().withMessage('Invalid property ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    // Get agency ID safely (handle both ObjectId and null)
    const propertyAgencyId = property.agency ? property.agency.toString() : null;
    const propertyAgentId = property.agent ? property.agent.toString() : null;
    const creatorId = property.createdBy?.toString();

    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && propertyAgencyId && propertyAgencyId !== req.user.agency) {
      return res.status(403).json({ message: 'Access denied to this agency property' });
    }

    if (req.user.role === 'agent') {
      if (propertyAgentId !== req.user.id && creatorId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. You can only delete your own assigned properties.' });
      }
      // Also ensure it's in their agency
      if (propertyAgencyId && propertyAgencyId !== req.user.agency) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    await Property.deleteOne({ _id: req.params.id });
    res.json({ message: 'Property deleted successfully' });
  } catch (error) {
    console.error('Delete property error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/properties/:id/entry-permissions
// @desc    Update entry-specific permissions for a property
// @access  Private (Super Admin)
router.put('/:id/entry-permissions', auth, authorize('super_admin'), async (req, res) => {
  try {
    const { entryPermissions } = req.body;

    if (!entryPermissions) {
      return res.status(400).json({ message: 'entryPermissions is required' });
    }

    const property = await Property.findByIdAndUpdate(
      req.params.id,
      { $set: { entryPermissions } },
      { new: true, runValidators: true }
    );

    if (!property) {
      return res.status(404).json({ message: 'Property not found' });
    }

    res.json(property);
  } catch (error) {
    console.error('Update entry permissions error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

