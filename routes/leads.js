const express = require('express');
const { body, validationResult, query } = require('express-validator');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Property = require('../models/Property');
const User = require('../models/User');
const Agency = require('../models/Agency');
const { auth, authorize, optionalAuth, checkModulePermission, validateEntryPermission, validateAgencyIsolation } = require('../middleware/auth');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const leadAssignmentService = require('../services/leadAssignmentService');
const leadScoringService = require('../services/leadScoringService');
const webhookService = require('../services/webhookService');
const encryptionService = require('../services/encryptionService');

const router = express.Router();

const activeStatuses = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation'];


// Helper function to normalize lead priority
const getNormalizedPriority = (priority) => {
  const validPriorities = ['Hot', 'Warm', 'Cold', 'Not_interested'];
  const priorityMap = {
    'high': 'Hot',
    'medium': 'Warm',
    'low': 'Warm', // Changed from Cold
    'urgent': 'Hot',
    'hot': 'Hot',
    'warm': 'Warm',
    'cold': 'Warm', // Changed from Cold
    'not_interested': 'Warm' // Changed from Not_interested as per user request for inquiries
  };

  if (!priority) return 'Warm';
  const p = String(priority).toLowerCase();

  // Check if it's already a valid capitalized priority
  const normalizedValid = validPriorities.find(v => v.toLowerCase() === p);
  // If it's Cold or Not_interested but coming from a form normalization, we might still want Warm
  // But for now, let's just use the map for most common cases
  return priorityMap[p] || 'Warm';
};

// Helper function to normalize lead source
const getNormalizedSource = (source) => {
  const validSources = ['website', 'phone', 'email', 'walk_in', 'referral', 'social_media', 'other'];
  const sourceMap = {
    'fb': 'social_media',
    'facebook': 'social_media',
    'instagram': 'social_media',
    'google': 'social_media',
    'social': 'social_media',
    'call': 'phone',
    'personal': 'walk_in'
  };

  if (!source) return 'website';
  const s = String(source).toLowerCase();
  return sourceMap[s] || (validSources.includes(s) ? s : 'other');
};

const normalizeLeadPriority = (lead) => {
  if (lead) {
    lead.priority = getNormalizedPriority(lead.priority);
  }
  return lead;
};

const normalizeLeadData = (lead) => {
  if (lead) {
    lead.priority = getNormalizedPriority(lead.priority);
    lead.source = getNormalizedSource(lead.source);
  }
  return lead;
};

// @route   GET /api/leads/my-inquiries
// @desc    Get inquiries for current customer
// @access  Private
router.get('/my-inquiries', auth, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const inquiries = await Lead.find({ 'contact.email': userEmail })
      .populate('property', 'title slug images price location')
      .populate('interestedProperties.property', 'title slug images price location')
      .populate('agency', 'name logo')
      .populate('assignedAgent', 'firstName lastName email profileImage')
      .sort('-createdAt');

    // Decrypt contact information
    const decryptedInquiries = inquiries.map(lead => {
      const leadObj = lead.toObject();
      if (leadObj.contact) {
        leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
      }
      normalizeLeadData(leadObj);
      return leadObj;
    });

    res.json(decryptedInquiries);
  } catch (error) {
    console.error('Get my inquiries error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/leads
// @desc    Get all leads
// @access  Private
router.get('/', auth, checkModulePermission('leads', 'view'), [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 2000 }),
  query('status').optional().isIn(['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation', 'booked', 'lost', 'closed', 'junk']),
  query('priority').optional().isIn(['Hot', 'Warm', 'Cold', 'Not_interested'])
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
    let hasUnassignedFilter = false;

    // Handle agency filter FIRST (before role-based filtering) to allow unassigned override
    // Only super_admin can filter by unassigned, others are limited to their own agency
    if (req.query.agency && req.query.agency === 'unassigned' && req.user.role === 'super_admin') {
      // For unassigned, filter where agency is null or doesn't exist
      // In MongoDB, { agency: null } matches both null values and missing fields
      hasUnassignedFilter = true;
      // Use $or to explicitly check for both null and missing
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { agency: null },
          { agency: { $exists: false } }
        ]
      });
    } else {
      // Role-based filtering (only if not filtering by unassigned)
      // STRICT ISOLATION: Users can ONLY see leads from their own agency
      const userAgencyId = req.user.agency && mongoose.Types.ObjectId.isValid(req.user.agency)
        ? new mongoose.Types.ObjectId(req.user.agency)
        : req.user.agency;

      if (req.user.role === 'agency_admin') {
        // Agency admin visibility: ONLY leads from their agency
        filter.agency = userAgencyId;
        // Entry permissions are respected but cannot override agency restriction
        filter[`entryPermissions.agency_admin.view`] = { $ne: false };
      } else if (req.user.role === 'agent') {
        const agentId = mongoose.Types.ObjectId.isValid(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : req.user.id;

        // Agent visibility: ONLY inquiries/leads assigned to this agent
        filter.agency = userAgencyId;
        filter.assignedAgent = agentId;
        filter[`entryPermissions.agent.view`] = { $ne: false };

        console.log(`🔍 Agent ${req.user.id} filtering leads - only assigned to agent`);
      } else if (req.user.role === 'staff') {
        // Staff has global access logic same as Super Admin, so we do nothing here (falls through)
      }

      // Handle agency filter from query parameter (for super_admin and staff)
      if (req.query.agency && (req.user.role === 'super_admin' || req.user.role === 'staff')) {
        if (mongoose.Types.ObjectId.isValid(req.query.agency)) {
          filter.agency = new mongoose.Types.ObjectId(req.query.agency);
        }
      }
    }

    // Team-wise filtering
    if (req.query.team) {
      filter.team = req.query.team;
    }

    // Reporting manager filtering
    if (req.query.reportingManager) {
      if (mongoose.Types.ObjectId.isValid(req.query.reportingManager)) {
        filter.reportingManager = new mongoose.Types.ObjectId(req.query.reportingManager);
      } else {
        filter.reportingManager = req.query.reportingManager;
      }
    }

    if (req.query.status) filter.status = req.query.status;
    if (req.query.priority) filter.priority = req.query.priority;
    if (req.query.owner) {
      // Validate ObjectId format before adding to filter
      if (mongoose.Types.ObjectId.isValid(req.query.owner)) {
        filter.assignedAgent = new mongoose.Types.ObjectId(req.query.owner);
      } else {
        filter.assignedAgent = req.query.owner;
      }
    }
    if (req.query.source) filter.source = req.query.source;
    if (req.query.property) {
      // Validate ObjectId format before adding to filter
      if (mongoose.Types.ObjectId.isValid(req.query.property)) {
        filter.property = new mongoose.Types.ObjectId(req.query.property);
      }
    }
    if (req.query.campaign) {
      filter.campaignName = new RegExp(req.query.campaign, 'i');
    }
    if (req.query.search) {
      const searchTerm = req.query.search.trim();
      const searchWords = searchTerm.split(/\s+/).filter(word => word.length > 0);
      const searchConditions = [];

      // For multi-word searches, handle firstName and lastName separately
      if (searchWords.length > 1) {
        // Search for first word in firstName and remaining words in lastName
        const firstNameSearch = searchWords[0];
        const lastNameSearch = searchWords.slice(1).join(' ');

        // Match: firstName contains first word AND lastName contains remaining words
        searchConditions.push({
          $and: [
            { 'contact.firstName': new RegExp(firstNameSearch, 'i') },
            { 'contact.lastName': new RegExp(lastNameSearch, 'i') }
          ]
        });

        // Also try reverse: lastName contains first word AND firstName contains remaining words
        searchConditions.push({
          $and: [
            { 'contact.lastName': new RegExp(firstNameSearch, 'i') },
            { 'contact.firstName': new RegExp(lastNameSearch, 'i') }
          ]
        });

        // Also search for full name in either field (for cases where name is stored in one field)
        searchConditions.push({ 'contact.firstName': new RegExp(searchTerm, 'i') });
        searchConditions.push({ 'contact.lastName': new RegExp(searchTerm, 'i') });
      } else {
        // Single word search - search in firstName or lastName
        searchConditions.push({ 'contact.firstName': new RegExp(searchTerm, 'i') });
        searchConditions.push({ 'contact.lastName': new RegExp(searchTerm, 'i') });
      }

      // Always search in email, phone, and leadId regardless of word count
      searchConditions.push({ 'contact.email': new RegExp(searchTerm, 'i') });
      searchConditions.push({ 'contact.phone': new RegExp(searchTerm, 'i') });
      searchConditions.push({ 'leadId': new RegExp(searchTerm, 'i') });

      // Also search by MongoDB _id if the search term looks like an ObjectId
      if (searchTerm.match(/^[0-9a-fA-F]{24}$/)) {
        try {
          searchConditions.push({ _id: new mongoose.Types.ObjectId(searchTerm) });
        } catch (error) {
          // Invalid ObjectId format, ignore
        }
      }

      // If there's already an $and (from unassigned filter), add search to it
      if (hasUnassignedFilter || filter.$and) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: searchConditions });
      } else {
        filter.$or = searchConditions;
      }
    }

    // Date range filtering
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        try {
          // Parse date string (YYYY-MM-DD format) and set to start of day
          const startDateStr = req.query.startDate;
          if (startDateStr && startDateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const [year, month, day] = startDateStr.split('-').map(Number);
            const startDate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
            filter.createdAt.$gte = startDate;
          }
        } catch (error) {
          console.error('Error parsing startDate:', error);
        }
      }
      if (req.query.endDate) {
        try {
          // Parse date string (YYYY-MM-DD format) and set to end of day
          const endDateStr = req.query.endDate;
          if (endDateStr && endDateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const [year, month, day] = endDateStr.split('-').map(Number);
            const endDate = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
            filter.createdAt.$lte = endDate;
          }
        } catch (error) {
          console.error('Error parsing endDate:', error);
        }
      }
    }

    // Debug: Log filter when unassigned is selected
    if (hasUnassignedFilter) {
      console.log('🔍 Unassigned filter applied:', JSON.stringify(filter, null, 2));
    }

    const leads = await Lead.find(filter)
      .populate({
        path: 'property',
        select: 'title slug images price location agent',
        populate: {
          path: 'agent',
          select: 'firstName lastName profileImage'
        }
      })
      .populate('interestedProperties.property', 'title slug images price location')
      .populate('agency', 'name logo')
      .populate('assignedAgent', 'firstName lastName email profileImage')
      .populate('assignedBy', 'firstName lastName')
      .populate('reportingManager', 'firstName lastName email')
      .populate('reminders.createdBy', 'firstName lastName')
      .sort('-createdAt')
      .skip(skip)
      .limit(limit);

    // Decrypt sensitive contact information if encryption is enabled
    const decryptedLeads = leads.map(lead => {
      const leadObj = lead.toObject();
      if (leadObj.contact) {
        leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
      }
      // Normalize data for display consistency
      normalizeLeadData(leadObj);
      return leadObj;
    });

    const total = await Lead.countDocuments(filter);

    res.json({
      leads: decryptedLeads,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/leads/:id
// @desc    Get single lead
// @access  Private
router.get('/:id', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate('property', 'title slug images price location')
      .populate('siteVisit.property', 'title slug')
      .populate('siteVisits.property', 'title slug')
      .populate('interestedProperties.property', 'title slug images price location')
      .populate('agency', 'name logo')
      .populate('assignedAgent', 'firstName lastName email phone profileImage agentInfo')
      .populate('assignedBy', 'firstName lastName')
      .populate('reportingManager', 'firstName lastName email phone')
      .populate('notes.createdBy', 'firstName lastName')
      .populate('communications.createdBy', 'firstName lastName')
      .populate('tasks.assignedTo', 'firstName lastName')
      .populate('tasks.createdBy', 'firstName lastName')
      .populate('reminders.createdBy', 'firstName lastName')
      .populate('documents.uploadedBy', 'firstName lastName')
      .populate('activityLog.performedBy', 'firstName lastName');

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    // Get lead agency ID (handle both populated object and ID string)
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    // Get user agency ID (handle both populated object and ID string)
    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    // Agency admin and staff can only view leads from their agency
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only view leads from your agency.' });
    }

    // Agent can view leads assigned to them OR unassigned leads from their agency
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      // If lead is assigned to someone else, deny access
      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }

      // If lead is unassigned or assigned to this agent, check agency match
      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }

    // Decrypt contact information if encryption is enabled
    const leadObj = lead.toObject();
    if (leadObj.contact) {
      leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
    }

    // Normalize data for display consistency
    normalizeLeadData(leadObj);

    res.json({ lead: leadObj });
  } catch (error) {
    console.error('Get lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/leads/:id/inquiries
// @desc    Get inquiries/history for the same customer (by email/phone), excluding current lead by default
// @access  Private
router.get(
  '/:id/inquiries',
  auth,
  checkModulePermission('leads', 'view'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 500 }),
    query('includeSelf').optional().isBoolean().toBoolean()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;
      const includeSelf = req.query.includeSelf === true || req.query.includeSelf === 'true';

      const baseLead = await Lead.findById(req.params.id)
        .populate('agency', 'name logo')
        .populate('assignedAgent', 'firstName lastName email phone profileImage agentInfo');

      if (!baseLead) {
        return res.status(404).json({ message: 'Lead not found' });
      }

      // Permission checks (same logic as GET /api/leads/:id)
      const leadAgencyId = baseLead.agency?._id
        ? baseLead.agency._id.toString()
        : (baseLead.agency?.toString() || baseLead.agency);

      const userAgencyId = req.user.agency?._id
        ? req.user.agency._id.toString()
        : (req.user.agency?.toString() || req.user.agency);

      if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. You can only view leads from your agency.' });
      }

      if (req.user.role === 'agent') {
        const assignedAgentId = baseLead.assignedAgent?._id
          ? baseLead.assignedAgent._id.toString()
          : (baseLead.assignedAgent?.toString() || baseLead.assignedAgent);

        if (assignedAgentId && assignedAgentId !== req.user.id) {
          return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
        }

        if (leadAgencyId !== userAgencyId) {
          return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
        }
      }

      // Build customer match filter (email/phone). Stored contact may be encrypted in DB,
      // but we can still match on raw stored values of the baseLead document.
      const matchOr = [];

      // DECRYPT baseLead contact first if it's encrypted so we get plain text email/phone
      // We rely on encryptionService to potentially decrypt it, BUT wait... 
      // If we want to search the DB, and the DB has ENCRYPTED data with random IV, we are screwed regardless.
      // But if the DB has plain text, we need plain text search.
      // If baseLead is raw (encrypted), and we search for raw, we only find exact IV matches (self).

      // Let's log what we have
      console.log(`[DEBUG] Fetching inquiries for lead ${req.params.id}`);

      // If data is encrypted, we MUST decrypt it to know the email/phone for display,
      // but for SEARCHING other records, we can't search by encrypted value if IV is random.
      // Assuming for now that either encryption is OFF or we are searching for plain text.

      let searchEmail = baseLead.contact?.email;
      let searchPhone = baseLead.contact?.phone;

      // Check if values look encrypted (hex string of typical length?) or just use as is.
      // Actually, if we want to support the case where encryption is OFF, we should just use the values.

      if (searchEmail) {
        // Ensure lowercase for email as per schema
        if (typeof searchEmail === 'string') {
          // If it looks like an email, lowercase it. If it's encrypted hex, lowercasing might break it if it wasn't already.
          // But the schema says lowercase: true, so it was lowercased BEFORE encryption if encrypted?
          // No, schema lowercase applies to the value being saved. 
          // If encrypted, the hex string is saved.

          // If plain text email
          if (searchEmail.includes('@')) {
            matchOr.push({ 'contact.email': searchEmail.toLowerCase() });
          } else {
            // Assume encrypted or other format, use as exact match
            matchOr.push({ 'contact.email': searchEmail });
          }
        }
      }

      if (searchPhone) {
        matchOr.push({ 'contact.phone': searchPhone });
      }

      console.log(`[DEBUG] Match conditions:`, JSON.stringify(matchOr));

      if (matchOr.length === 0) {
        return res.json({
          inquiries: [],
          pagination: { page, limit, total: 0, pages: 0 }
        });
      }

      const filter = { $or: matchOr };
      if (!includeSelf) {
        filter._id = { $ne: baseLead._id };
      }

      const inquiries = await Lead.find(filter)
        .populate({
          path: 'property',
          select: 'title slug images price location agent',
          populate: { path: 'agent', select: 'firstName lastName profileImage' }
        })
        .populate('interestedProperties.property', 'title slug images price location agent')
        .populate('agency', 'name logo')
        .populate('assignedAgent', 'firstName lastName email profileImage')
        .sort('-createdAt')
        .skip(skip)
        .limit(limit);

      const total = await Lead.countDocuments(filter);

      const decrypted = inquiries.map(lead => {
        const leadObj = lead.toObject();
        if (leadObj.contact) {
          leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
        }
        normalizeLeadData(leadObj);
        return leadObj;
      });

      // De-dupe by _id (defensive)
      const uniqueById = new Map();
      decrypted.forEach((inq) => {
        const id = (inq?._id || '').toString();
        if (!id) return;
        if (!uniqueById.has(id)) uniqueById.set(id, inq);
      });

      res.json({
        inquiries: Array.from(uniqueById.values()),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Get lead inquiries error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// @route   POST /api/leads/:id/contact-agent
// @desc    Customer sends a contact request to the assigned agent
// @access  Private
router.post('/:id/contact-agent', auth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .populate('property', 'title slug images price location')
      .populate('agency', 'name logo contact')
      .populate('assignedAgent', 'firstName lastName email phone profileImage');

    if (!lead) {
      return res.status(404).json({ message: 'Inquiry not found' });
    }

    // Security: Only the owner of the inquiry can send contact request
    // Decrypt lead contact email to compare with user email
    const decryptedContact = encryptionService.decryptLeadContact(lead.contact);
    if (decryptedContact.email !== req.user.email) {
      console.log(`Access denied for contact-agent: user ${req.user.email} vs lead contact ${decryptedContact.email}`);
      return res.status(403).json({ message: 'Access denied' });
    }

    // Prepare lead data with decrypted contact for email service
    const leadWithDecryptedContact = lead.toObject();
    leadWithDecryptedContact.contact = decryptedContact;

    if (!lead.assignedAgent) {
      // If no agent assigned, notify agency admin
      const agencyAdmins = await User.find({
        role: 'agency_admin',
        agency: lead.agency?._id,
        isActive: true
      });

      if (agencyAdmins.length > 0) {
        // Send to first agency admin
        await emailService.sendContactAgentRequest(leadWithDecryptedContact, agencyAdmins[0], lead.agency);

        // Add a note
        lead.notes.push({
          note: `Customer ${decryptedContact.firstName} requested to contact agent. No agent assigned, notified admin ${agencyAdmins[0].firstName}.`,
          createdBy: lead.agency?._id, // System or Agency account if possible, using req.user.id for now
          createdAt: new Date()
        });
      } else {
        return res.status(400).json({ message: 'No agent or administrator available for this inquiry' });
      }
    } else {
      await emailService.sendContactAgentRequest(leadWithDecryptedContact, lead.assignedAgent, lead.agency);
    }

    // Add communication record
    lead.communications.push({
      type: 'email',
      subject: 'Contact Agent Request',
      message: `Customer ${decryptedContact.firstName} ${decryptedContact.lastName} requested to be contacted by the agent.`,
      direction: 'inbound',
      createdBy: req.user.id,
      createdAt: new Date()
    });

    lead.activityLog.push({
      action: 'communication_added',
      details: { description: 'Contact Agent Request sent by customer' },
      performedBy: req.user.id
    });

    await lead.save();

    res.json({ message: 'Agent has been notified and will contact you soon' });
  } catch (error) {
    console.error('Contact agent error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});



// @route   POST /api/leads
// @desc    Create new lead (from website form or manually)
// @access  Public (website) / Private (manual)
router.post('/', optionalAuth, [
  body('contact.firstName').trim().notEmpty().withMessage('First name is required'),
  body('contact.lastName').trim().notEmpty().withMessage('Last name is required'),
  body('contact.email').isEmail().withMessage('Valid email is required'),
  body('contact.phone').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    // If it's a manual creation by staff, verify permissions
    if (req.user && ['super_admin', 'agency_admin', 'agent', 'staff'].includes(req.user.role)) {
      // Permission check could be added here if needed for staff manual entry
    }

    // SECURITY: Agency admin and agents can only create leads for their own agency
    let agencyId = req.body.agency;

    if (req.user) {
      if (req.user.role === 'agency_admin' || req.user.role === 'agent') {
        // Must have an agency assigned
        if (!req.user.agency) {
          return res.status(403).json({
            message: 'Your account is not associated with an agency. Please contact the administrator.',
            code: 'NO_AGENCY_ASSIGNED'
          });
        }

        // If trying to create for different agency, block
        if (agencyId && agencyId.toString() !== req.user.agency.toString()) {
          return res.status(403).json({
            message: 'You can only create leads for your own agency',
            code: 'AGENCY_MISMATCH'
          });
        }

        // Force agency to their own
        agencyId = req.user.agency;
      } else if (req.user.role === 'super_admin') {
        // Super admin must specify agency or it defaults below
      } else if (req.user.role === 'staff' || req.user.role === 'user') {
        // Staff/user might not have agency - use their agency or provided agency
        if (!agencyId && req.user.agency) {
          agencyId = req.user.agency;
        }
      }
    }

    // If no agency determined, try default
    if (!agencyId) {
      const defaultAgency = await Agency.findOne({ isActive: true }).sort({ createdAt: 1 });
      if (!defaultAgency) {
        return res.status(400).json({
          message: 'No active agency found. Please contact the administrator.',
          code: 'NO_AGENCY_AVAILABLE'
        });
      }
      agencyId = defaultAgency._id;
    }

    // Validate the agency exists
    const agency = await Agency.findById(agencyId);
    if (!agency) {
      return res.status(400).json({ message: 'Selected agency does not exist' });
    }

    // Check for duplicate leads (by email or phone)
    const duplicateConditions = [
      { 'contact.email': req.body.contact.email.toLowerCase() }
    ];

    // Only add phone to duplicate check if phone is provided
    if (req.body.contact.phone && req.body.contact.phone.trim()) {
      duplicateConditions.push({ 'contact.phone': req.body.contact.phone });
    }

    // Notifications function to use for both new and existing leads
    const sendNotifications = async (targetLeadId) => {
      try {
        console.log(`[Notification] Starting notifications for lead: ${targetLeadId}`);
        const leadToNotify = await Lead.findById(targetLeadId)
          .populate('property', 'title slug agent agency')
          .populate('agency', 'name contact settings')
          .populate('assignedAgent', 'firstName lastName email phone');

        if (!leadToNotify) {
          console.error(`[Notification] Lead ${targetLeadId} not found for notifications`);
          return;
        }

        // Decrypt contact for notification visibility
        if (leadToNotify.contact) {
          leadToNotify.contact = encryptionService.decryptLeadContact(
            leadToNotify.contact.toObject ? leadToNotify.contact.toObject() : leadToNotify.contact
          );
        }

        const recipientEmails = new Set();

        // 1. Get Agency contact email
        if (leadToNotify.agency?.contact?.email) {
          recipientEmails.add(leadToNotify.agency.contact.email.toLowerCase().trim());
        }

        // 2. Add Agency Admins
        const agencyAdmins = await User.find({
          role: 'agency_admin',
          agency: leadToNotify.agency?._id,
          isActive: true
        });
        agencyAdmins.forEach(u => {
          if (u.email) recipientEmails.add(u.email.toLowerCase().trim());
        });

        // 3. Add Property Agent
        if (leadToNotify.property?.agent) {
          const propAgent = await User.findById(leadToNotify.property.agent);
          if (propAgent?.email) {
            recipientEmails.add(propAgent.email.toLowerCase().trim());
          }
        }

        // 4. Add Lead Assigned Agent
        if (leadToNotify.assignedAgent?.email) {
          recipientEmails.add(leadToNotify.assignedAgent.email.toLowerCase().trim());

          // SMS if enabled
          if (leadToNotify.agency?.settings?.smsNotifications) {
            smsService.sendLeadNotification(leadToNotify, leadToNotify.assignedAgent)
              .catch(err => console.error('[SMS Error]', err));
          }
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const recipientsArray = Array.from(recipientEmails).filter(e => emailRegex.test(e));

        console.log(`[Notification] Sending bulk notification to ${recipientsArray.length} recipients: ${recipientsArray.join(', ')}`);

        if (recipientsArray.length > 0) {
          await emailService.sendBulkLeadNotification(leadToNotify, leadToNotify.agency, recipientsArray);
        }

        // 5. Customer Confirmation
        if (leadToNotify.contact?.email) {
          console.log(`[Notification] Sending confirmation to customer: ${leadToNotify.contact.email}`);
          await emailService.sendInquiryConfirmation(leadToNotify);
        }
      } catch (err) {
        console.error('[Notification Error]', err);
      }
    };

    // SEARCH DUPLICATES OR CREATE NEW
    // Search for existing lead in the same agency
    let lead = null;
    if (!req.body.ignoreDuplicates) {
      lead = await Lead.findOne({
        $or: duplicateConditions,
        agency: agencyId
      });
    }

    if (lead) {
      // If lead exists and property is provided, add it to interestedProperties
      if (req.body.property) {
        const alreadyInterested = lead.interestedProperties?.some(ip =>
          ip.property?.toString() === req.body.property.toString()
        );

        if (!alreadyInterested) {
          lead.interestedProperties = lead.interestedProperties || [];
          lead.interestedProperties.push({
            property: req.body.property,
            action: 'inquiry',
            date: new Date()
          });
        }
      }

      // Update basic info if provided (optional, but good for keeping it fresh)
      if (req.body.contact.firstName) lead.contact.firstName = req.body.contact.firstName;
      if (req.body.contact.lastName) lead.contact.lastName = req.body.contact.lastName;

      lead.activityLog.push({
        action: 'lead_updated',
        details: { description: 'Lead inquiry updated (duplicate prevented)' },
        performedBy: req.user ? req.user.id : null
      });

      await lead.save();

      const populatedLead = await Lead.findById(lead._id)
        .populate('property', 'title slug agent agency')
        .populate('agency', 'name contact settings')
        .populate('assignedAgent', 'firstName lastName email phone');

      const leadObj = populatedLead.toObject();
      if (leadObj.contact) {
        leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
      }

      // Trigger notifications even for duplicate inquiries (updates)
      setImmediate(async () => {
        try {
          // Re-score the lead on new inquiry even if it exists
          // This will upgrade priority to Warm if it was Not_interested
          await leadScoringService.autoScoreLead(lead._id, true);
          sendNotifications(lead._id);
        } catch (err) {
          console.error('[Notification/Scoring Error]', err);
          sendNotifications(lead._id); // Fallback to just notifications
        }
      });

      return res.json({
        lead: leadObj,
        message: 'Existing lead updated',
        isExisting: true
      });
    }

    // Auto-assign agent if not provided and auto-assignment is enabled
    let assignedAgentId = req.body.assignedAgent || null;
    if (req.user) {
      const agency = await Agency.findById(agencyId);
      if (!assignedAgentId) {
        if (agency?.settings?.autoAssignLeads) {
          const assignmentMethod = agency.settings.assignmentMethod || 'round_robin';
          assignedAgentId = await leadAssignmentService.autoAssignLead(agencyId, assignmentMethod, req.body);
        }
      }
    }

    // SECURITY: Validate assigned agent is from same agency
    if (assignedAgentId) {
      const assignedAgent = await User.findById(assignedAgentId);
      if (!assignedAgent) {
        return res.status(400).json({ message: 'Assigned agent not found' });
      }
      // Agent must be from same agency (or be from an agency if no agency filter)
      if (assignedAgent.agency && assignedAgent.agency.toString() !== agencyId.toString()) {
        return res.status(403).json({
          message: 'Cannot assign agents from different agencies',
          code: 'AGENT_AGENCY_MISMATCH'
        });
      }
    }

    // Map common frontend values to backend values
    const priority = getNormalizedPriority(req.body.priority);
    const source = getNormalizedSource(req.body.source);

    // Validate and normalize status
    const validStatuses = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation', 'booked', 'lost', 'closed', 'junk'];
    const status = req.body.status && validStatuses.includes(req.body.status.toLowerCase())
      ? req.body.status.toLowerCase()
      : 'new';

    const leadData = {
      ...req.body,
      agency: agencyId,
      source: source,
      status: status,
      priority: priority,
      assignedAgent: assignedAgentId
    };

    // Clean up inquiry object - remove empty budget fields
    if (leadData.inquiry && leadData.inquiry.budget) {
      if (!leadData.inquiry.budget.min && !leadData.inquiry.budget.max) {
        // If both min and max are missing, keep only currency if provided
        if (leadData.inquiry.budget.currency) {
          leadData.inquiry.budget = { currency: leadData.inquiry.budget.currency };
        } else {
          delete leadData.inquiry.budget;
        }
      }
    }

    lead = new Lead(leadData);

    // Initialize SLA tracking
    lead.sla = {
      firstContactSla: 3600000, // 1 hour default
      firstContactStatus: 'pending'
    };

    lead.activityLog.push({
      action: 'lead_created',
      details: { description: 'Lead created' },
      performedBy: req.user ? req.user.id : null
    });

    await lead.save();

    // Auto-score the lead
    try {
      // Don't auto-update priority if it was manually set during creation
      const shouldUpdatePriority = !req.body.hasOwnProperty('priority');
      await leadScoringService.autoScoreLead(lead._id, shouldUpdatePriority);
    } catch (scoreError) {
      console.error('Error auto-scoring lead:', scoreError);
      // Don't fail the request if scoring fails
    }

    const populatedLead = await Lead.findById(lead._id)
      .populate('property', 'title slug agent agency')
      .populate('agency', 'name contact')
      .populate('assignedAgent', 'firstName lastName email phone');

    // Decrypt contact information for notifications and response
    if (populatedLead.contact) {
      populatedLead.contact = encryptionService.decryptLeadContact(populatedLead.contact.toObject ? populatedLead.contact.toObject() : populatedLead.contact);
    }
    const leadObj = populatedLead.toObject();
    if (leadObj.contact) {
      leadObj.contact = populatedLead.contact; // Reuse decrypted contact
    }

    // Trigger notifications for new lead
    setImmediate(() => sendNotifications(lead._id));

    // Send webhook for lead creation
    if (webhookService.isEnabled()) {
      try {
        await webhookService.sendLeadWebhook(populatedLead, 'lead_created');
      } catch (webhookError) {
        console.error('Error sending lead creation webhook:', webhookError);
        // Don't fail the request if webhook fails
      }
    }

    res.status(201).json({ lead: leadObj });
  } catch (error) {
    console.error('Create lead error:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', JSON.stringify(req.body, null, 2));

    // Return more detailed error message
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      return res.status(400).json({
        message: 'Validation error',
        errors: validationErrors
      });
    }

    res.status(500).json({
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// @route   DELETE /api/leads/:id/documents/:docId
// @desc    Delete a single document from a lead
// @access  Private
router.delete('/:id/documents/:docId', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // SECURITY: Validate per-entry permissions
    const entryPermCheck = validateEntryPermission(lead, req.user, 'edit');
    if (!entryPermCheck.allowed) {
      console.log(`Document delete blocked - Entry permission denied: ${entryPermCheck.reason}, Lead: ${req.params.id}, Role: ${req.user.role}`);
      return res.status(403).json({
        message: 'Access denied by entry-level restriction',
        reason: entryPermCheck.reason
      });
    }

    // SECURITY: Validate agency isolation
    const agencyCheck = validateAgencyIsolation(lead, req.user);
    if (!agencyCheck.allowed) {
      console.log(`Document delete blocked - Agency isolation failed: ${agencyCheck.reason}, Lead: ${req.params.id}`);
      return res.status(403).json({
        message: 'Access denied. You can only update leads from your agency.',
        reason: agencyCheck.reason
      });
    }

    // SECURITY: Agent can only modify leads assigned to them
    if (req.user.role === 'agent') {
      const agentId = mongoose.Types.ObjectId.isValid(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : req.user.id;
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      const isPropertyManager = await Property.exists({ _id: lead.property, agent: agentId });

      if (assignedAgentId !== req.user.id && !isPropertyManager) {
        console.log(`Document delete blocked - Agent not assigned to lead: ${req.params.id}, Agent: ${req.user.id}, Assigned to: ${assignedAgentId}`);
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }
    }

    const docIndex = lead.documents.findIndex(
      d => d._id && d._id.toString() === req.params.docId
    );

    if (docIndex === -1) {
      return res.status(404).json({ message: 'Document not found on this lead' });
    }

    const [removedDoc] = lead.documents.splice(docIndex, 1);

    // Activity log for audit trail
    lead.activityLog.push({
      action: 'document_deleted',
      details: {
        field: 'documents',
        oldValue: {
          _id: removedDoc._id,
          name: removedDoc.name,
          filename: removedDoc.filename,
          url: removedDoc.url,
          type: removedDoc.type,
          size: removedDoc.size
        },
        newValue: null,
        description: `Document "${removedDoc.name || removedDoc.filename || removedDoc._id}" deleted`
      },
      performedBy: req.user.id
    });

    await lead.save();

    return res.json({
      message: 'Document deleted successfully',
      document: removedDoc
    });
  } catch (error) {
    console.error('Delete lead document error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/leads/:id
// @desc    Update lead
// @access  Private
router.put('/:id', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // SECURITY: Validate per-entry permissions
    const entryPermCheck = validateEntryPermission(lead, req.user, 'edit');
    if (!entryPermCheck.allowed) {
      console.log(`Update blocked - Entry permission denied: ${entryPermCheck.reason}, Lead: ${req.params.id}, Role: ${req.user.role}`);
      return res.status(403).json({
        message: 'Access denied by entry-level restriction',
        reason: entryPermCheck.reason
      });
    }

    // SECURITY: Validate agency isolation
    const agencyCheck = validateAgencyIsolation(lead, req.user);
    if (!agencyCheck.allowed) {
      console.log(`Update blocked - Agency isolation failed: ${agencyCheck.reason}, Lead: ${req.params.id}`);
      return res.status(403).json({
        message: 'Access denied. You can only update leads from your agency.',
        reason: agencyCheck.reason
      });
    }

    // SECURITY: Agent can only update leads assigned to them
    if (req.user.role === 'agent') {
      const agentId = mongoose.Types.ObjectId.isValid(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : req.user.id;
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      // Check assigned agent or property ownership
      const isPropertyManager = await Property.exists({ _id: lead.property, agent: agentId });

      if (assignedAgentId !== req.user.id && !isPropertyManager) {
        console.log(`Update blocked - Agent not assigned to lead: ${req.params.id}, Agent: ${req.user.id}, Assigned to: ${assignedAgentId}`);
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }
    }

    // Capture previous state for webhooks and logic
    const previousStatus = lead.status;
    const previousPriority = lead.priority;
    const previousAssignedAgent = lead.assignedAgent;

    // Activity Log Tracking
    const activityLogs = [];

    // Track Status Change
    if (req.body.status && req.body.status !== previousStatus) {
      activityLogs.push({
        action: 'status_change',
        details: {
          field: 'status',
          oldValue: previousStatus,
          newValue: req.body.status,
          description: `Status changed from ${previousStatus} to ${req.body.status}`
        },
        performedBy: req.user.id
      });
    }

    // Track Priority Change
    if (req.body.priority) {
      const newPriority = getNormalizedPriority(req.body.priority);
      if (newPriority !== previousPriority) {
        activityLogs.push({
          action: 'priority_change',
          details: {
            field: 'priority',
            oldValue: previousPriority,
            newValue: newPriority,
            description: `Priority changed from ${previousPriority} to ${newPriority}`
          },
          performedBy: req.user.id
        });
      }
    }

    // Track General Updates (if not specific status/priority)
    if (activityLogs.length === 0 && Object.keys(req.body).length > 0) {
      // Optional: Log generic update if needed, but keeping it clean for now
      // Or we can log specific important field changes here
    }

    if (activityLogs.length > 0) {
      lead.activityLog.push(...activityLogs);
    }

    // Normalize priority and source if provided
    if (req.body.hasOwnProperty('priority')) {
      req.body.priority = getNormalizedPriority(req.body.priority);
    }

    if (req.body.hasOwnProperty('source')) {
      req.body.source = getNormalizedSource(req.body.source);
    }

    // Normalize status if provided
    if (req.body.status) {
      const validStatuses = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation', 'booked', 'lost', 'closed', 'junk'];
      const currentStatus = req.body.status.toLowerCase();
      if (validStatuses.includes(currentStatus)) {
        req.body.status = currentStatus;
      } else {
        // Try to map common variations
        const statusMap = {
          'site visit': 'site_visit_scheduled',
          'site_visit': 'site_visit_scheduled',
          'new lead': 'new'
        };
        req.body.status = statusMap[currentStatus] || 'new';
      }
    }

    // Encrypt contact information if being updated
    if (req.body.contact) {
      req.body.contact = encryptionService.encryptLeadContact(req.body.contact);
    }

    // Handle nested objects properly (deep merge for inquiry, booking, etc.)
    if (req.body.inquiry) {
      // Deep merge inquiry object to preserve existing values
      if (!lead.inquiry) lead.inquiry = {};
      if (req.body.inquiry.budget) {
        lead.inquiry.budget = {
          ...lead.inquiry.budget,
          ...req.body.inquiry.budget
        };
        // Ensure budget values are numbers
        if (lead.inquiry.budget.min !== undefined) {
          lead.inquiry.budget.min = parseFloat(lead.inquiry.budget.min) || null;
        }
        if (lead.inquiry.budget.max !== undefined) {
          lead.inquiry.budget.max = parseFloat(lead.inquiry.budget.max) || null;
        }
      }
      // Merge other inquiry fields
      Object.assign(lead.inquiry, req.body.inquiry);
    }

    // Handle other nested objects
    if (req.body.booking) {
      if (!lead.booking) lead.booking = {};
      Object.assign(lead.booking, req.body.booking);
    }

    // Assign other top-level fields
    const fieldsToAssign = { ...req.body };
    delete fieldsToAssign.inquiry;
    delete fieldsToAssign.booking;
    Object.assign(lead, fieldsToAssign);

    // We already normalized at the beginning

    await lead.save();

    // Recalculate lead score in real-time when lead is updated
    // This ensures score updates when source, budget, timeline, or inquiry changes
    try {
      // Don't auto-update priority if it was manually set in this update
      const shouldUpdatePriority = !req.body.hasOwnProperty('priority');
      await leadScoringService.autoScoreLead(lead._id, shouldUpdatePriority);
    } catch (scoreError) {
      console.error('Error recalculating lead score:', scoreError);
      // Don't fail the update if scoring fails
    }

    // Fetch updated lead with fresh score data
    const updatedLead = await Lead.findById(lead._id)
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName');

    // Decrypt contact information if encryption is enabled
    const leadObj = updatedLead.toObject();
    if (leadObj.contact) {
      leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
    }

    // Send assignment notification if agent changed (background task)
    const newAssignedAgentId = updatedLead.assignedAgent?._id?.toString() || updatedLead.assignedAgent?.toString();
    const oldAssignedAgentId = previousAssignedAgent?._id?.toString() || previousAssignedAgent?.toString();

    if (newAssignedAgentId && newAssignedAgentId !== oldAssignedAgentId) {
      setImmediate(async () => {
        try {
          const [agent, agency] = await Promise.all([
            User.findById(newAssignedAgentId).select('firstName lastName email team'),
            Agency.findById(updatedLead.agency?._id || updatedLead.agency).select('name settings')
          ]);

          if (agent && agency) {
            emailService.sendLeadAssignmentNotification(leadObj, agent, agency).catch(err => {
              console.error('Error sending email notification:', err);
            });
          }
        } catch (notifError) {
          console.error('Error sending assignment notification on update:', notifError);
        }
      });
    }

    // Send webhook for lead update
    if (webhookService.isEnabled()) {
      try {
        const previousData = {
          status: previousStatus,
          priority: previousPriority,
          assignedAgent: previousAssignedAgent
        };

        // Determine event type based on what changed
        let eventType = 'lead_updated';
        if (req.body.status && req.body.status !== previousStatus) {
          eventType = 'status_changed';

          // Special events for important status changes
          if (req.body.status === 'booked') {
            eventType = 'lead_booked';
          } else if (req.body.status === 'closed') {
            eventType = 'lead_closed';
          } else if (req.body.status === 'lost') {
            eventType = 'lead_lost';
          }
        }

        await webhookService.sendLeadWebhook(leadObj, eventType, previousData);
      } catch (webhookError) {
        console.error('Error sending lead update webhook:', webhookError);
        // Don't fail the request if webhook fails
      }
    }

    res.json({ lead: leadObj });
  } catch (error) {
    console.error('Update lead error:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', JSON.stringify(req.body, null, 2));

    // Return more detailed error message
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => ({
        field: err.path,
        message: err.message
      }));
      return res.status(400).json({
        message: 'Validation error',
        errors: validationErrors
      });
    }

    res.status(500).json({
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/leads/:id/notes
// @desc    Add note to lead
// @access  Private
router.post('/:id/notes', auth, checkModulePermission('leads', 'edit'), [
  body('note').trim().notEmpty().withMessage('Note is required')
], async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions - same as GET route
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    // Agency admin and staff can only add notes to leads from their agency
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only add notes to leads from your agency.' });
    }

    // Agent can only add notes to leads assigned to them
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }

      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }

    // Normalize priority before saving
    normalizeLeadData(lead);

    lead.notes.push({
      note: req.body.note,
      createdBy: req.user.id
    });

    lead.activityLog.push({
      action: 'note_added',
      details: { description: 'Note added' },
      performedBy: req.user.id
    });

    await lead.save();
    res.json({ lead });
  } catch (error) {
    console.error('Add note error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/leads/:id/notes/:noteId
// @desc    Update a note
// @access  Private
router.put('/:id/notes/:noteId', auth, checkModulePermission('leads', 'edit'), [
  body('note').trim().notEmpty().withMessage('Note is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    const leadAgencyId = lead.agency?._id ? lead.agency._id.toString() : (lead.agency?.toString() || lead.agency);
    const userAgencyId = req.user.agency?._id ? req.user.agency._id.toString() : (req.user.agency?.toString() || req.user.agency);
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only edit notes for leads from your agency.' });
    }
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id ? lead.assignedAgent._id.toString() : (lead.assignedAgent?.toString() || lead.assignedAgent);
      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }
      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }
    const noteId = req.params.noteId;
    const note = lead.notes.id(noteId);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }
    note.note = req.body.note;
    await lead.save();
    const updatedLead = await Lead.findById(lead._id).populate('notes.createdBy', 'firstName lastName');
    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Update note error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/leads/:id/notes/:noteId
// @desc    Delete a note
// @access  Private
router.delete('/:id/notes/:noteId', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    const leadAgencyId = lead.agency?._id ? lead.agency._id.toString() : (lead.agency?.toString() || lead.agency);
    const userAgencyId = req.user.agency?._id ? req.user.agency._id.toString() : (req.user.agency?.toString() || req.user.agency);
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only delete notes for leads from your agency.' });
    }
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id ? lead.assignedAgent._id.toString() : (lead.assignedAgent?.toString() || lead.assignedAgent);
      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }
      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }
    const noteId = req.params.noteId;
    const note = lead.notes.id(noteId);
    if (!note) {
      return res.status(404).json({ message: 'Note not found' });
    }
    note.deleteOne();
    await lead.save();
    const updatedLead = await Lead.findById(lead._id).populate('notes.createdBy', 'firstName lastName');
    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Delete note error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/:id/communications
// @desc    Add communication to lead
// @access  Private
router.post('/:id/communications', auth, checkModulePermission('leads', 'edit'), [
  body('type').isIn(['call', 'email', 'sms', 'meeting', 'note']).withMessage('Valid communication type is required'),
  body('message').trim().notEmpty().withMessage('Message is required')
], async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions - same as GET route
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    // Agency admin and staff can only add communications to leads from their agency
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only add communications to leads from your agency.' });
    }

    // Agent can only add communications to leads assigned to them
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }

      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }

    // Normalize priority before saving
    normalizeLeadData(lead);

    const communication = {
      ...req.body,
      createdBy: req.user.id
    };

    lead.communications.push(communication);

    lead.activityLog.push({
      action: 'communication_added',
      details: {
        description: `${req.body.type.charAt(0).toUpperCase() + req.body.type.slice(1)} logged: ${req.body.subject || 'No subject'}`
      },
      performedBy: req.user.id
    });

    // Track SLA - mark first contact if this is the first communication
    if (!lead.sla.firstContactAt && req.body.type !== 'note') {
      lead.sla.firstContactAt = new Date();
      lead.sla.responseTime = lead.sla.firstContactAt - lead.createdAt;

      // Check if SLA was met (default 1 hour)
      const slaThreshold = lead.sla.firstContactSla || 3600000; // 1 hour
      if (lead.sla.responseTime <= slaThreshold) {
        lead.sla.firstContactStatus = 'met';
      } else {
        lead.sla.firstContactStatus = 'breached';
      }
    }

    // Update last contact time
    lead.sla.lastContactAt = new Date();

    await lead.save();

    // Recalculate lead score in real-time when communication is added
    // This updates engagement score based on communications
    try {
      await leadScoringService.autoScoreLead(lead._id);
    } catch (scoreError) {
      console.error('Error recalculating lead score:', scoreError);
      // Don't fail the communication add if scoring fails
    }

    // Fetch updated lead with new score
    const updatedLead = await Lead.findById(lead._id)
      .populate('communications.createdBy', 'firstName lastName');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Add communication error:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', JSON.stringify(req.body, null, 2));
    res.status(500).json({
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   POST /api/leads/:id/tasks
// @desc    Add task to lead
// @access  Private
router.post('/:id/tasks', auth, checkModulePermission('leads', 'edit'), [
  body('title').trim().notEmpty().withMessage('Task title is required')
], async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    // Agency admin and staff can only add tasks to leads from their agency
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only add tasks to leads from your agency.' });
    }

    // Agent can only add tasks to leads assigned to them
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }

      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }

    // Normalize priority before saving
    normalizeLeadData(lead);

    lead.tasks.push({
      ...req.body,
      createdBy: req.user.id
    });

    lead.activityLog.push({
      action: 'task_added',
      details: { description: `Task created: ${req.body.title}` },
      performedBy: req.user.id
    });

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('tasks.assignedTo', 'firstName lastName')
      .populate('tasks.createdBy', 'firstName lastName');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Add task error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/leads/:id/tasks/:taskId
// @desc    Update task
// @access  Private
router.put('/:id/tasks/:taskId', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    // Agency admin and staff can only update tasks on leads from their agency
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only update tasks on leads from your agency.' });
    }

    // Agent can only update tasks on leads assigned to them
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }

      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }

    const task = lead.tasks.id(req.params.taskId);
    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (req.body.title) task.title = req.body.title;
    if (req.body.description !== undefined) task.description = req.body.description;
    if (req.body.dueDate) task.dueDate = new Date(req.body.dueDate);
    if (req.body.taskType) task.taskType = req.body.taskType;
    if (req.body.status) {
      task.status = req.body.status;
      if (req.body.status === 'completed' && !task.completedAt) {
        task.completedAt = new Date();
      } else if (req.body.status !== 'completed') {
        task.completedAt = undefined;
      }
    }
    if (req.body.assignedTo !== undefined) task.assignedTo = req.body.assignedTo;

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('tasks.assignedTo', 'firstName lastName')
      .populate('tasks.createdBy', 'firstName lastName');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/leads/:id/tasks/:taskId
// @desc    Delete task
// @access  Private
router.delete('/:id/tasks/:taskId', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    // Agency admin and staff can only delete tasks on leads from their agency
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only delete tasks on leads from your agency.' });
    }

    // Agent can only delete tasks on leads assigned to them
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }

      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }

    lead.tasks.id(req.params.taskId).remove();
    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('tasks.assignedTo', 'firstName lastName')
      .populate('tasks.createdBy', 'firstName lastName');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/:id/reminders
// @desc    Add reminder to lead
// @access  Private
router.post('/:id/reminders', auth, checkModulePermission('leads', 'edit'), [
  body('title').trim().notEmpty().withMessage('Reminder title is required'),
  body('reminderDate').isISO8601().withMessage('Valid reminder date is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    // Agency admin and staff can only add reminders to leads from their agency
    if ((req.user.role === 'agency_admin' || req.user.role === 'staff') && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied. You can only add reminders to leads from your agency.' });
    }

    // Agent can only add reminders to leads assigned to them
    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId && assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied. This lead is not assigned to you.' });
      }

      if (leadAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied. This lead is not from your agency.' });
      }
    }

    // Validate and convert reminder date
    const reminderDate = new Date(req.body.reminderDate);
    if (isNaN(reminderDate.getTime())) {
      return res.status(400).json({ message: 'Invalid reminder date format' });
    }

    // Ensure createdBy is a valid ObjectId
    if (!req.user || !req.user.id) {
      return res.status(401).json({ message: 'User not authenticated' });
    }

    // Normalize priority before saving
    normalizeLeadData(lead);

    lead.reminders.push({
      title: req.body.title.trim(),
      description: (req.body.description || '').trim(),
      reminderDate: reminderDate,
      createdBy: req.user.id
    });

    lead.activityLog.push({
      action: 'reminder_added',
      details: { description: `Reminder set: ${req.body.title}` },
      performedBy: req.user.id
    });

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('reminders.createdBy', 'firstName lastName');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Add reminder error:', error);
    console.error('Error stack:', error.stack);
    console.error('Request body:', JSON.stringify(req.body, null, 2));
    console.error('User:', req.user ? { id: req.user.id, role: req.user.role } : 'No user');
    res.status(500).json({
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   PUT /api/leads/:id/reminders/:reminderId
// @desc    Update reminder
// @access  Private
router.put('/:id/reminders/:reminderId', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    if (req.user.role === 'agency_admin' && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    const reminder = lead.reminders.id(req.params.reminderId);
    if (!reminder) {
      return res.status(404).json({ message: 'Reminder not found' });
    }

    if (req.body.title) reminder.title = req.body.title;
    if (req.body.description !== undefined) reminder.description = req.body.description;
    if (req.body.reminderDate) reminder.reminderDate = new Date(req.body.reminderDate);
    if (req.body.isCompleted !== undefined) {
      reminder.isCompleted = req.body.isCompleted;
      if (req.body.isCompleted && !reminder.completedAt) {
        reminder.completedAt = new Date();
      } else if (!req.body.isCompleted) {
        reminder.completedAt = undefined;
      }
    }

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('reminders.createdBy', 'firstName lastName');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Update reminder error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/leads/:id/reminders/:reminderId
// @desc    Delete reminder
// @access  Private
router.delete('/:id/reminders/:reminderId', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    const leadAgencyId = lead.agency?._id
      ? lead.agency._id.toString()
      : (lead.agency?.toString() || lead.agency);

    const userAgencyId = req.user.agency?._id
      ? req.user.agency._id.toString()
      : (req.user.agency?.toString() || req.user.agency);

    if (req.user.role === 'agency_admin' && leadAgencyId !== userAgencyId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (req.user.role === 'agent') {
      const assignedAgentId = lead.assignedAgent?._id
        ? lead.assignedAgent._id.toString()
        : (lead.assignedAgent?.toString() || lead.assignedAgent);

      if (assignedAgentId !== req.user.id) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    lead.reminders.id(req.params.reminderId).remove();
    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('reminders.createdBy', 'firstName lastName');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Delete reminder error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/leads/:id/assign
// @desc    Assign lead to agent
// @access  Private
router.put('/:id/assign', auth, checkModulePermission('leads', 'edit'), [
  body('assignedAgent').notEmpty().withMessage('Agent ID is required')
], async (req, res) => {
  try {
    // Fetch lead and agent in parallel for better performance
    const [lead, agent] = await Promise.all([
      Lead.findById(req.params.id).populate('agency', 'name').populate('property', 'title slug'),
      req.body.assignedAgent ? User.findById(req.body.assignedAgent).select('firstName lastName team email') : null
    ]);

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if (!agent) {
      return res.status(404).json({ message: 'Agent not found' });
    }

    // Capture previous assignment
    const previousAgentId = lead.assignedAgent;

    // Update lead assignment fields
    lead.assignedAgent = req.body.assignedAgent;
    lead.assignedBy = req.user.id;

    // Log Assignment Change
    if (String(previousAgentId) !== String(req.body.assignedAgent)) {
      lead.activityLog.push({
        action: 'assignment_change',
        details: {
          field: 'assignedAgent',
          oldValue: previousAgentId,
          newValue: req.body.assignedAgent,
          description: 'Lead manually assigned to a new agent'
        },
        performedBy: req.user.id
      });
    }

    // Set reporting manager (if provided, otherwise use current user if they're a manager)
    if (req.body.reportingManager) {
      lead.reportingManager = req.body.reportingManager;
    } else if (req.user.role === 'agency_admin' || req.user.isTeamLead) {
      lead.reportingManager = req.user.id;
    }

    // Set team (if provided, otherwise get from assigned agent)
    if (req.body.team) {
      lead.team = req.body.team;
    } else if (agent.team) {
      lead.team = agent.team;
    }

    // Normalize priority before saving to prevent validation errors
    normalizeLeadData(lead);

    await lead.save();

    // Get agency if not already populated
    const agency = lead.agency?._id ? lead.agency : await Agency.findById(lead.agency).select('name settings');

    // Prepare response immediately (don't wait for notifications/scoring)
    const updatedLead = await Lead.findById(lead._id)
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email');

    // Decrypt contact information if encryption is enabled
    const leadObj = updatedLead.toObject();
    if (leadObj.contact) {
      leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
    }

    // Return response immediately for fast API response
    res.json({ lead: leadObj });

    // Handle time-consuming operations in background (don't block response)
    setImmediate(async () => {
      try {
        // Recalculate lead score in background
        await leadScoringService.autoScoreLead(lead._id);
      } catch (scoreError) {
        console.error('Error recalculating lead score:', scoreError);
      }

      // Send notifications in background
      try {
        if (agent && agency) {
          // Use the already decrypted leadObj for notifications
          // Send email notification (async, don't wait)
          emailService.sendLeadAssignmentNotification(leadObj, agent, agency).catch(err => {
            console.error('Error sending email notification:', err);
          });

          // Send SMS notification if enabled (async, don't wait)
          if (agency?.settings?.smsNotifications) {
            smsService.sendLeadAssignmentNotification(leadObj, agent).catch(err => {
              console.error('Error sending SMS notification:', err);
            });
          }
        }
      } catch (notifError) {
        console.error('Error sending assignment notifications:', notifError);
      }
    });
  } catch (error) {
    console.error('Assign lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/:id/auto-assign
// @desc    Auto-assign lead using specified method
// @access  Private (Super Admin, Agency Admin)
router.post('/:id/auto-assign', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    // Default to round_robin if not provided
    const assignmentMethod = req.body.assignmentMethod || 'round_robin';

    // Validate assignment method
    const validMethods = ['round_robin', 'workload', 'location', 'project', 'source', 'smart'];
    if (!validMethods.includes(assignmentMethod)) {
      return res.status(400).json({
        message: `Invalid assignment method. Must be one of: ${validMethods.join(', ')}`,
        received: assignmentMethod
      });
    }

    const lead = await Lead.findById(req.params.id)
      .populate('property', 'title')
      .populate('agency', 'name');

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Get agency ID - prefer from request, then from lead, then from user
    let agencyId = req.body.agencyId;
    if (!agencyId) {
      agencyId = lead.agency?._id || lead.agency;
    }
    if (!agencyId && req.user.agency) {
      agencyId = req.user.agency;
    }
    if (!agencyId) {
      return res.status(400).json({
        message: 'Agency is required for auto-assignment. Please provide agencyId or ensure lead has an agency assigned.'
      });
    }

    // Convert to ObjectId if it's a string
    if (typeof agencyId === 'string' && mongoose.Types.ObjectId.isValid(agencyId)) {
      agencyId = new mongoose.Types.ObjectId(agencyId);
    }

    // Prepare lead data for assignment
    const leadData = {
      property: lead.property?._id || lead.property,
      source: lead.source,
      inquiry: lead.inquiry || {}
    };

    // Auto-assign using specified method
    let assignedAgentId;
    try {
      console.log(`Attempting auto-assignment: method=${assignmentMethod}, agencyId=${agencyId}`);
      assignedAgentId = await leadAssignmentService.autoAssignLead(
        agencyId,
        assignmentMethod,
        leadData
      );
      console.log(`Auto-assignment result: ${assignedAgentId ? 'Success - Agent ID: ' + assignedAgentId : 'No agent found'}`);
    } catch (assignError) {
      console.error('Error in auto-assignment service:', assignError);
      return res.status(500).json({
        message: 'Error during auto-assignment',
        error: assignError.message,
        stack: process.env.NODE_ENV === 'development' ? assignError.stack : undefined
      });
    }

    if (!assignedAgentId) {
      // Check if there are any agents in the agency
      const agentCount = await User.countDocuments({
        role: 'agent',
        agency: agencyId,
        isActive: true
      });

      return res.status(400).json({
        message: agentCount === 0
          ? 'No active agents found in this agency. Please add agents before auto-assigning leads.'
          : 'No available agent found for assignment with the selected method. Try a different assignment method.',
        assignmentMethod: assignmentMethod,
        agencyId: agencyId.toString(),
        agentCount: agentCount
      });
    }

    // Assign the lead
    lead.assignedAgent = assignedAgentId;
    lead.assignedBy = req.user.id;

    lead.activityLog.push({
      action: 'assignment_change',
      details: {
        field: 'assignedAgent',
        newValue: assignedAgentId,
        description: `Lead auto-assigned via ${assignmentMethod}`
      },
      performedBy: req.user.id
    });

    // Set reporting manager and team
    const agent = await User.findById(assignedAgentId);
    if (agent) {
      if (agent.team) {
        lead.team = agent.team;
      }
      // Set reporting manager if agent has one
      if (req.user.role === 'agency_admin' || req.user.isTeamLead) {
        lead.reportingManager = req.user.id;
      }
    }

    // Normalize priority before saving to prevent validation errors
    normalizeLeadData(lead);

    await lead.save();

    // Recalculate lead score
    try {
      await leadScoringService.autoScoreLead(lead._id);
    } catch (scoreError) {
      console.error('Error recalculating lead score:', scoreError);
    }

    const updatedLead = await Lead.findById(lead._id)
      .populate('assignedAgent', 'firstName lastName')
      .populate('property', 'title slug')
      .populate('agency', 'name');

    const leadObj = updatedLead.toObject();
    if (leadObj.contact) {
      leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
    }

    // Send notifications in background
    setImmediate(async () => {
      try {
        const [populatedAgent, populatedAgency] = await Promise.all([
          User.findById(assignedAgentId),
          Agency.findById(agencyId)
        ]);
        if (populatedAgent && populatedAgency) {
          await emailService.sendLeadAssignmentNotification(leadObj, populatedAgent, populatedAgency);
        }
      } catch (notifError) {
        console.error('Error sending assignment notifications:', notifError);
      }
    });

    res.json({
      lead: leadObj,
      assignmentMethod: assignmentMethod,
      message: `Lead auto-assigned using ${assignmentMethod.replace('_', ' ')} method`
    });
  } catch (error) {
    console.error('Auto-assign lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/:id/re-score
// @desc    Re-score a lead
// @access  Private (Super Admin, Agency Admin, Agent)
router.post('/:id/re-score', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin') {
      const leadAgencyId = lead.agency?._id || lead.agency;
      if (leadAgencyId.toString() !== req.user.agency.toString()) {
        return res.status(403).json({ message: 'Access denied' });
      }
    } else if (req.user.role === 'agent') {
      if (lead.assignedAgent?.toString() !== req.user.id.toString()) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    // Re-score the lead
    await leadScoringService.autoScoreLead(lead._id);

    const updatedLead = await Lead.findById(lead._id);
    const leadObj = updatedLead.toObject();
    if (leadObj.contact) {
      leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
    }

    res.json({
      lead: leadObj,
      message: 'Lead re-scored successfully'
    });
  } catch (error) {
    console.error('Re-score lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/:id/merge
// @desc    Merge lead with another lead
// @access  Private (Super Admin, Agency Admin)
router.post('/:id/merge', auth, checkModulePermission('leads', 'edit'), [
  body('targetLeadId').isMongoId().withMessage('Valid target lead ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const sourceLead = await Lead.findById(req.params.id);
    const targetLead = await Lead.findById(req.body.targetLeadId);

    if (!sourceLead || !targetLead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check permissions
    if (req.user.role === 'agency_admin') {
      const sourceAgencyId = sourceLead.agency?._id || sourceLead.agency;
      const targetAgencyId = targetLead.agency?._id || targetLead.agency;
      if (sourceAgencyId.toString() !== req.user.agency || targetAgencyId.toString() !== req.user.agency) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    // Merge source lead into target lead
    // Combine notes
    if (sourceLead.notes && sourceLead.notes.length > 0) {
      targetLead.notes = [...(targetLead.notes || []), ...sourceLead.notes];
    }

    // Combine communications
    if (sourceLead.communications && sourceLead.communications.length > 0) {
      targetLead.communications = [...(targetLead.communications || []), ...sourceLead.communications];
    }

    // Combine tasks
    if (sourceLead.tasks && sourceLead.tasks.length > 0) {
      targetLead.tasks = [...(targetLead.tasks || []), ...sourceLead.tasks];
    }

    // Update target lead with best data
    if (!targetLead.assignedAgent && sourceLead.assignedAgent) {
      targetLead.assignedAgent = sourceLead.assignedAgent;
    }
    if (targetLead.status === 'new' && sourceLead.status !== 'new') {
      targetLead.status = sourceLead.status;
    }
    if (targetLead.priority === 'medium' && sourceLead.priority !== 'medium') {
      targetLead.priority = sourceLead.priority;
    }

    await targetLead.save();

    // Delete source lead
    await Lead.deleteOne({ _id: sourceLead._id });

    const mergedLead = await Lead.findById(targetLead._id)
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName');

    res.json({
      message: 'Leads merged successfully',
      lead: mergedLead,
      mergedFrom: {
        _id: sourceLead._id,
        name: `${sourceLead.contact.firstName} ${sourceLead.contact.lastName}`
      }
    });
  } catch (error) {
    console.error('Merge lead error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// @route   GET /api/leads/:id/duplicates
// @desc    Find duplicate leads
// @access  Private
router.get('/:id/duplicates', auth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Find duplicates by email or phone
    const duplicates = await Lead.find({
      _id: { $ne: lead._id },
      agency: lead.agency,
      $or: [
        { 'contact.email': lead.contact.email.toLowerCase() },
        { 'contact.phone': lead.contact.phone }
      ]
    })
      .populate('assignedAgent', 'firstName lastName')
      .sort({ createdAt: -1 });

    res.json({ duplicates });
  } catch (error) {
    console.error('Find duplicates error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', auth, checkModulePermission('leads', 'delete'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Validate per-entry permissions
    const entryPermCheck = validateEntryPermission(lead, req.user, 'delete');
    if (!entryPermCheck.allowed) {
      console.log(`Delete blocked - Entry permission denied: ${entryPermCheck.reason}, Lead: ${req.params.id}, Role: ${req.user.role}`);
      return res.status(403).json({
        message: 'Access denied by entry-level restriction',
        reason: entryPermCheck.reason
      });
    }

    // Validate agency isolation
    const agencyCheck = validateAgencyIsolation(lead, req.user);
    if (!agencyCheck.allowed) {
      console.log(`Delete blocked - Agency isolation failed: ${agencyCheck.reason}, Lead: ${req.params.id}, User Agency: ${agencyCheck.userAgency}, Doc Agency: ${agencyCheck.documentAgency}`);
      return res.status(403).json({
        message: 'Access denied. You can only delete leads from your agency.',
        reason: agencyCheck.reason
      });
    }

    // All permission checks passed
    console.log(`Deleting lead ${req.params.id} - User: ${req.user.id}, Role: ${req.user.role}, Agency: ${req.user.agency}`);
    await Lead.findByIdAndDelete(req.params.id);

    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Delete lead error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ message: 'Server error', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
});

// @route   POST /api/leads/bulk
// @desc    Create multiple leads from CSV/Excel upload
// @access  Private
router.post('/bulk', auth, checkModulePermission('leads', 'create'), async (req, res) => {
  try {
    const { leads } = req.body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ message: 'No leads data provided' });
    }

    // SECURITY: Determine agency for leads
    let defaultAgencyId = null;
    if (req.user.role === 'super_admin') {
      // Super admin must provide agency in each lead or use a default
      const firstLeadAgency = leads.find(l => l.agency);
      if (firstLeadAgency) {
        defaultAgencyId = firstLeadAgency.agency;
      } else {
        // Get first active agency as default
        const defaultAgency = await Agency.findOne({ isActive: true }).sort({ createdAt: 1 });
        if (!defaultAgency) {
          return res.status(400).json({ message: 'No active agency found. Please specify an agency for the leads.' });
        }
        defaultAgencyId = defaultAgency._id;
      }
    } else if (req.user.role === 'agency_admin' || req.user.role === 'agent') {
      // SECURITY: Agency admin/agents can ONLY use their own agency
      if (!req.user.agency) {
        return res.status(403).json({
          message: 'Your account is not associated with an agency.',
          code: 'NO_AGENCY_ASSIGNED'
        });
      }
      defaultAgencyId = req.user.agency;
    } else {
      // Other roles use their agency or default
      defaultAgencyId = req.user.agency;
      if (!defaultAgencyId) {
        const defaultAgency = await Agency.findOne({ isActive: true }).sort({ createdAt: 1 });
        if (!defaultAgency) {
          return res.status(400).json({ message: 'Your account is not associated with an agency.' });
        }
        defaultAgencyId = defaultAgency._id;
      }
    }

    const createdLeads = [];
    const errors = [];

    for (let i = 0; i < leads.length; i++) {
      const leadData = leads[i];

      try {
        // Validate required fields with detailed error messages
        if (!leadData.contact) {
          errors.push({
            row: leadData._rowIndex || i + 1,
            error: 'Missing contact information'
          });
          continue;
        }

        const missingFields = [];
        if (!leadData.contact.firstName || leadData.contact.firstName.trim().length === 0) {
          missingFields.push('firstName');
        }
        if (!leadData.contact.email || leadData.contact.email.trim().length === 0 || !leadData.contact.email.includes('@')) {
          missingFields.push('email');
        }
        if (!leadData.contact.phone || leadData.contact.phone.trim().length === 0) {
          missingFields.push('phone');
        }

        if (missingFields.length > 0) {
          errors.push({
            row: leadData._rowIndex || i + 1,
            error: `Missing required fields: ${missingFields.join(', ')}`
          });
          continue;
        }

        // SECURITY: Agency isolation check
        let agencyId = defaultAgencyId;
        if (leadData.agency) {
          // SECURITY: Non-super-admin cannot specify different agency
          if (req.user.role !== 'super_admin') {
            return res.status(403).json({
              message: 'You can only create leads for your own agency',
              code: 'AGENCY_OVERRIDE_DENIED'
            });
          }

          // Check if it's already an ObjectId
          if (mongoose.Types.ObjectId.isValid(leadData.agency) && String(leadData.agency).length === 24) {
            agencyId = new mongoose.Types.ObjectId(leadData.agency);
          } else {
            // It's a name, find the agency by name
            try {
              const agency = await Agency.findOne({
                name: new RegExp(`^${leadData.agency.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
                isActive: true
              });
              if (agency) {
                agencyId = agency._id;
                console.log(`✅ Resolved agency "${leadData.agency}" to ObjectId: ${agencyId}`);
              } else {
                // Agency not found, use default
                console.warn(`⚠️ Agency "${leadData.agency}" not found, using default agency: ${defaultAgencyId}`);
                // Don't change agencyId, keep using defaultAgencyId
              }
            } catch (agencyError) {
              console.error(`Error resolving agency "${leadData.agency}":`, agencyError);
              // Use default agency on error
            }
          }
        }

        // Final validation - ensure agencyId is a valid ObjectId
        if (!agencyId || !mongoose.Types.ObjectId.isValid(agencyId)) {
          errors.push({
            row: leadData._rowIndex || i + 1,
            error: `Invalid agency: ${leadData.agency || 'not provided'}. Could not resolve to a valid agency.`
          });
          continue;
        }

        // Resolve property if propertyTitle is provided
        let propertyId = leadData.property || null;
        if (leadData.propertyTitle && !propertyId) {
          const Property = require('../models/Property');
          // Make sure agencyId is a valid ObjectId before querying
          if (agencyId && mongoose.Types.ObjectId.isValid(agencyId)) {
            const property = await Property.findOne({
              title: new RegExp(leadData.propertyTitle.trim(), 'i'),
              agency: agencyId
            });
            if (property) {
              propertyId = property._id;
            }
          }
        }

        // SECURITY: Resolve and validate assigned agent
        let assignedAgentId = leadData.assignedAgent || null;
        if (leadData.assignedAgentName && !assignedAgentId) {
          // Make sure agencyId is a valid ObjectId before querying
          if (agencyId && mongoose.Types.ObjectId.isValid(agencyId)) {
            // Try to find agent by name (firstName + lastName or full name)
            const agentNameParts = leadData.assignedAgentName.trim().split(/\s+/);
            let agent = null;

            if (agentNameParts.length >= 2) {
              // Try full name match
              agent = await User.findOne({
                $or: [
                  {
                    firstName: new RegExp(agentNameParts[0], 'i'),
                    lastName: new RegExp(agentNameParts.slice(1).join(' '), 'i'),
                    role: 'agent',
                    agency: agencyId
                  },
                  {
                    $or: [
                      { firstName: new RegExp(leadData.assignedAgentName.trim(), 'i') },
                      { lastName: new RegExp(leadData.assignedAgentName.trim(), 'i') }
                    ],
                    role: 'agent',
                    agency: agencyId
                  }
                ]
              });
            } else {
              // Try single name match
              agent = await User.findOne({
                $or: [
                  { firstName: new RegExp(leadData.assignedAgentName.trim(), 'i') },
                  { lastName: new RegExp(leadData.assignedAgentName.trim(), 'i') },
                  { email: new RegExp(leadData.assignedAgentName.trim(), 'i') }
                ],
                role: 'agent',
                agency: agencyId
              });
            }

            if (agent) {
              assignedAgentId = agent._id;
            }
          }
        }

        // Validate status and priority
        const validStatuses = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation', 'booked', 'lost', 'closed', 'junk'];
        const validPriorities = ['Hot', 'Warm', 'Cold', 'Not_interested'];
        const validSources = ['website', 'phone', 'email', 'walk_in', 'referral', 'social_media', 'other'];

        // Encrypt contact information if encryption is enabled
        const encryptedContact = encryptionService.encryptLeadContact({
          firstName: leadData.contact.firstName.trim(),
          lastName: leadData.contact.lastName?.trim() || '',
          email: leadData.contact.email.trim().toLowerCase(),
          phone: leadData.contact.phone.trim(),
          alternatePhone: leadData.contact.alternatePhone?.trim(),
          address: leadData.contact.address || {}
        });

        const lead = new Lead({
          contact: encryptedContact,
          status: validStatuses.includes(leadData.status?.toLowerCase()) ? leadData.status.toLowerCase() : 'new',
          priority: validPriorities.includes(leadData.priority?.toLowerCase()) ? leadData.priority.toLowerCase() : 'Warm',
          source: validSources.includes(leadData.source?.toLowerCase()) ? leadData.source.toLowerCase() : 'other',
          agency: agencyId,
          property: propertyId && mongoose.Types.ObjectId.isValid(propertyId) ? propertyId : undefined,
          assignedAgent: assignedAgentId && mongoose.Types.ObjectId.isValid(assignedAgentId) ? assignedAgentId : undefined,
          inquiry: {
            message: leadData.inquiry?.message || '',
            budget: {
              min: leadData.inquiry?.budget?.min ? parseFloat(leadData.inquiry.budget.min) : undefined,
              max: leadData.inquiry?.budget?.max ? parseFloat(leadData.inquiry.budget.max) : undefined,
              currency: leadData.inquiry?.budget?.currency || 'USD'
            },
            preferredLocation: Array.isArray(leadData.inquiry?.preferredLocation)
              ? leadData.inquiry.preferredLocation.filter(l => l.trim())
              : [],
            propertyType: Array.isArray(leadData.inquiry?.propertyType)
              ? leadData.inquiry.propertyType.filter(t => t.trim())
              : [],
            timeline: leadData.inquiry?.timeline,
            requirements: leadData.inquiry?.requirements || ''
          }
        });

        await lead.save();
        createdLeads.push(lead._id);

        console.log(`✅ Lead created successfully: ${lead.contact.firstName} ${lead.contact.lastName} (${lead.contact.email})`);
      } catch (error) {
        console.error(`❌ Error creating lead at row ${leadData._rowIndex || i + 1}:`, error);
        errors.push({
          row: leadData._rowIndex || i + 1,
          error: error.message || 'Failed to create lead'
        });
      }
    }

    console.log(`📊 Bulk upload summary: ${createdLeads.length} created, ${errors.length} failed out of ${leads.length} total`);

    res.status(201).json({
      message: `Successfully created ${createdLeads.length} out of ${leads.length} leads`,
      created: createdLeads.length,
      failed: errors.length,
      total: leads.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Bulk create leads error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/landing-page
// @desc    Import leads from landing pages (dedicated endpoint)
// @access  Public (with optional API key validation)
router.post('/landing-page', optionalAuth, [
  body('leads').isArray().withMessage('Leads array is required'),
  body('landingPageName').optional().trim(),
  body('campaignName').optional().trim()
], async (req, res) => {
  try {
    const validationErrors = validationResult(req);
    if (!validationErrors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: validationErrors.array()
      });
    }

    const { leads, landingPageName, campaignName } = req.body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ message: 'No leads data provided' });
    }

    // Determine agency
    let agencyId = req.body.agency;
    if (req.user && req.user.role !== 'super_admin') {
      agencyId = req.user.agency || req.body.agency;
      if (!agencyId) {
        const defaultAgency = await Agency.findOne({ isActive: true }).sort({ createdAt: 1 });
        if (!defaultAgency) {
          return res.status(400).json({
            message: 'No active agency found',
            code: 'NO_AGENCY_REQUIRED'
          });
        }
        agencyId = defaultAgency._id;
      }
    } else if (!agencyId) {
      const defaultAgency = await Agency.findOne({ isActive: true }).sort({ createdAt: 1 });
      if (!defaultAgency) {
        return res.status(400).json({
          message: 'No active agency found',
          code: 'NO_AGENCY_AVAILABLE'
        });
      }
      agencyId = defaultAgency._id;
    }

    const createdLeads = [];
    const errors = [];

    for (let i = 0; i < leads.length; i++) {
      const leadData = leads[i];

      try {
        // Validate required fields
        if (!leadData.contact || !leadData.contact.email || !leadData.contact.firstName) {
          errors.push({
            row: i + 1,
            error: 'Missing required fields: contact.email and contact.firstName'
          });
          continue;
        }

        // Auto-assign agent if enabled
        let assignedAgentId = leadData.assignedAgent || null;
        if (!assignedAgentId) {
          const agency = await Agency.findById(agencyId);
          if (agency?.settings?.autoAssignLeads) {
            const assignmentMethod = agency.settings.assignmentMethod || 'round_robin';
            assignedAgentId = await leadAssignmentService.autoAssignLead(agencyId, assignmentMethod, leadData);
          }
        }

        // Prepare lead data
        const validStatuses = ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation', 'booked', 'lost', 'closed', 'junk'];
        const validPriorities = ['Hot', 'Warm', 'Cold', 'Not_interested'];
        const validSources = ['website', 'phone', 'email', 'walk_in', 'referral', 'social_media', 'other'];

        const newLeadData = {
          contact: {
            firstName: leadData.contact.firstName.trim(),
            lastName: leadData.contact.lastName?.trim() || '',
            email: leadData.contact.email.trim().toLowerCase(),
            phone: leadData.contact.phone?.trim() || '',
            alternatePhone: leadData.contact.alternatePhone?.trim(),
            address: leadData.contact.address || {}
          },
          status: validStatuses.includes(leadData.status?.toLowerCase()) ? leadData.status.toLowerCase() : 'new',
          priority: validPriorities.includes(leadData.priority?.toLowerCase()) ? leadData.priority.toLowerCase() : 'Warm',
          source: validSources.includes(leadData.source?.toLowerCase()) ? leadData.source.toLowerCase() : 'website',
          agency: agencyId,
          property: leadData.property && mongoose.Types.ObjectId.isValid(leadData.property) ? leadData.property : undefined,
          assignedAgent: assignedAgentId && mongoose.Types.ObjectId.isValid(assignedAgentId) ? assignedAgentId : undefined,
          campaignName: campaignName || leadData.campaignName || landingPageName || 'Landing Page',
          inquiry: {
            message: leadData.inquiry?.message || leadData.message || '',
            budget: {
              min: leadData.inquiry?.budget?.min ? parseFloat(leadData.inquiry.budget.min) : undefined,
              max: leadData.inquiry?.budget?.max ? parseFloat(leadData.inquiry.budget.max) : undefined,
              currency: leadData.inquiry?.budget?.currency || 'USD'
            },
            preferredLocation: Array.isArray(leadData.inquiry?.preferredLocation)
              ? leadData.inquiry.preferredLocation.filter(l => l.trim())
              : (leadData.preferredLocation ? [leadData.preferredLocation] : []),
            propertyType: Array.isArray(leadData.inquiry?.propertyType)
              ? leadData.inquiry.propertyType.filter(t => t.trim())
              : (leadData.propertyType ? [leadData.propertyType] : []),
            timeline: leadData.inquiry?.timeline || leadData.timeline,
            requirements: leadData.inquiry?.requirements || leadData.requirements || ''
          },
          tags: Array.isArray(leadData.tags) ? leadData.tags : (leadData.tags ? [leadData.tags] : ['landing_page'])
        };

        // Encrypt contact information if encryption is enabled
        if (newLeadData.contact) {
          newLeadData.contact = encryptionService.encryptLeadContact(newLeadData.contact);
        }

        const lead = new Lead(newLeadData);

        // Initialize SLA tracking
        lead.sla = {
          firstContactSla: 3600000, // 1 hour default
          firstContactStatus: 'pending'
        };

        await lead.save();

        // Auto-score the lead
        try {
          await leadScoringService.autoScoreLead(lead._id);
        } catch (scoreError) {
          console.error('Error auto-scoring lead:', scoreError);
        }

        createdLeads.push(lead._id);

        // Send notifications
        try {
          const agency = await Agency.findById(agencyId);
          if (lead.assignedAgent) {
            const agent = await User.findById(lead.assignedAgent);
            if (agent) {
              const populatedLead = await Lead.findById(lead._id)
                .populate('property', 'title slug')
                .populate('agency', 'name');

              await emailService.sendNewLeadNotification(populatedLead, agent, agency);

              if (agency?.settings?.smsNotifications) {
                await smsService.sendLeadNotification(populatedLead, agent);
              }
            }
          }
        } catch (notifError) {
          console.error('Error sending notifications:', notifError);
        }
      } catch (error) {
        console.error(`Error creating lead at row ${i + 1}:`, error);
        errors.push({
          row: i + 1,
          error: error.message || 'Failed to create lead'
        });
      }
    }

    res.status(201).json({
      message: `Successfully imported ${createdLeads.length} out of ${leads.length} leads from landing page`,
      created: createdLeads.length,
      failed: errors.length,
      total: leads.length,
      landingPageName: landingPageName || 'Unknown',
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Landing page import error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   POST /api/leads/webhook
// @desc    Webhook endpoint for external lead capture (ad platforms, portals)
// @access  Public (with API key validation)
router.post('/webhook', async (req, res) => {
  try {
    // Validate webhook API key
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const validApiKey = process.env.WEBHOOK_API_KEY;

    if (validApiKey && apiKey !== validApiKey) {
      return res.status(401).json({ message: 'Invalid API key' });
    }

    // Extract lead data from webhook payload
    const webhookData = req.body;

    // Map common webhook formats to our lead format
    const leadData = {
      contact: {
        firstName: webhookData.firstName || webhookData.first_name || webhookData.name?.split(' ')[0] || 'Unknown',
        lastName: webhookData.lastName || webhookData.last_name || webhookData.name?.split(' ').slice(1).join(' ') || '',
        email: webhookData.email || webhookData.email_address || '',
        phone: webhookData.phone || webhookData.phone_number || webhookData.mobile || '',
        alternatePhone: webhookData.alternatePhone || webhookData.alternate_phone
      },
      inquiry: {
        message: webhookData.message || webhookData.inquiry || webhookData.notes || '',
        budget: webhookData.budget ? {
          min: webhookData.budget.min || webhookData.budget,
          max: webhookData.budget.max || webhookData.budget
        } : undefined,
        preferredLocation: Array.isArray(webhookData.preferredLocation)
          ? webhookData.preferredLocation
          : (webhookData.preferredLocation ? [webhookData.preferredLocation] : []),
        propertyType: Array.isArray(webhookData.propertyType)
          ? webhookData.propertyType
          : (webhookData.propertyType ? [webhookData.propertyType] : []),
        timeline: webhookData.timeline,
        requirements: webhookData.requirements || webhookData.requirement
      },
      source: webhookData.source || 'other',
      campaignName: webhookData.campaignName || webhookData.campaign_name || webhookData.campaign,
      status: 'new',
      priority: 'Warm'
    };

    // Validate required fields
    if (!leadData.contact.email && !leadData.contact.phone) {
      return res.status(400).json({ message: 'Email or phone is required' });
    }

    // Find or create agency (use default agency if not specified)
    let agencyId = webhookData.agency;
    if (!agencyId) {
      const Agency = require('../models/Agency');
      const defaultAgency = await Agency.findOne({ isActive: true }).sort({ createdAt: 1 });
      if (!defaultAgency) {
        return res.status(400).json({ message: 'No active agency found' });
      }
      agencyId = defaultAgency._id;
    }

    // Auto-assign agent if enabled
    let assignedAgentId = webhookData.assignedAgent || null;
    if (!assignedAgentId) {
      const Agency = require('../models/Agency');
      const agency = await Agency.findById(agencyId);
      if (agency?.settings?.autoAssignLeads) {
        const assignmentMethod = agency.settings.assignmentMethod || 'round_robin';
        assignedAgentId = await leadAssignmentService.autoAssignLead(agencyId, assignmentMethod, leadData);
      }
    }

    leadData.agency = agencyId;
    leadData.assignedAgent = assignedAgentId;

    // Encrypt contact information if encryption is enabled
    if (leadData.contact) {
      leadData.contact = encryptionService.encryptLeadContact(leadData.contact);
    }

    // Create lead
    const lead = new Lead(leadData);

    // Initialize SLA tracking
    lead.sla = {
      firstContactSla: 3600000, // 1 hour default
      firstContactStatus: 'pending'
    };

    await lead.save();

    // Auto-score the lead
    try {
      await leadScoringService.autoScoreLead(lead._id);
    } catch (scoreError) {
      console.error('Error auto-scoring lead:', scoreError);
    }

    // Send notifications
    try {
      const Agency = require('../models/Agency');
      const agency = await Agency.findById(agencyId);

      if (assignedAgentId) {
        const User = require('../models/User');
        const agent = await User.findById(assignedAgentId);
        if (agent) {
          const populatedLead = await Lead.findById(lead._id)
            .populate('property', 'title slug')
            .populate('agency', 'name');

          await emailService.sendNewLeadNotification(populatedLead, agent, agency);

          if (agency?.settings?.smsNotifications) {
            await smsService.sendLeadNotification(populatedLead, agent);
          }
        }
      }
    } catch (notifError) {
      console.error('Error sending notifications:', notifError);
    }

    res.status(201).json({
      success: true,
      leadId: lead.leadId,
      leadMongoId: lead._id,
      message: 'Lead created successfully via webhook'
    });
  } catch (error) {
    console.error('Webhook lead creation error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   POST /api/leads/:id/site-visit
// @desc    Schedule site visit and send confirmation
// @access  Private
router.post('/:id/site-visit', auth, checkModulePermission('leads', 'edit'), [
  body('scheduledDate').isISO8601().withMessage('Valid scheduled date is required'),
  body('scheduledTime').trim().notEmpty().withMessage('Scheduled time is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Auto-assign agent if not assigned (especially when super admin schedules site visit)
    if (!lead.assignedAgent && lead.agency) {
      try {
        const Agency = require('../models/Agency');
        const agency = await Agency.findById(lead.agency);

        if (agency) {
          // Use agency's auto-assignment settings if enabled
          if (agency.settings?.autoAssignLeads) {
            const assignmentMethod = agency.settings.assignmentMethod || 'round_robin';
            const leadData = {
              property: lead.property,
              inquiry: lead.inquiry,
              source: lead.source
            };
            const assignedAgentId = await leadAssignmentService.autoAssignLead(
              lead.agency,
              assignmentMethod,
              leadData
            );

            if (assignedAgentId) {
              lead.assignedAgent = assignedAgentId;
              lead.assignedBy = req.user.id;
              console.log(`✅ Auto-assigned lead ${lead._id} to agent ${assignedAgentId} when scheduling site visit`);
            }
          } else {
            // If auto-assignment is disabled, use round-robin as fallback
            const assignedAgentId = await leadAssignmentService.roundRobinAssignment(lead.agency);
            if (assignedAgentId) {
              lead.assignedAgent = assignedAgentId;
              lead.assignedBy = req.user.id;
              console.log(`✅ Auto-assigned lead ${lead._id} to agent ${assignedAgentId} (round-robin fallback)`);
            }
          }
        }
      } catch (assignError) {
        console.error('Error auto-assigning agent during site visit scheduling:', assignError);
        // Don't fail the request if assignment fails
      }
    }

    // Ensure siteVisits array exists (migrate from single siteVisit if needed)
    if (!lead.siteVisits || !Array.isArray(lead.siteVisits)) {
      lead.siteVisits = [];
    }
    if (lead.siteVisit && lead.siteVisit.scheduledDate && lead.siteVisits.length === 0) {
      lead.siteVisits.push({
        ...lead.siteVisit.toObject ? lead.siteVisit.toObject() : lead.siteVisit,
        _id: lead.siteVisit._id || new (require('mongoose').Types.ObjectId)()
      });
    }

    const newVisit = {
      _id: new (require('mongoose').Types.ObjectId)(),
      scheduledDate: new Date(req.body.scheduledDate),
      scheduledTime: req.body.scheduledTime,
      status: 'scheduled',
      relationshipManager: req.body.relationshipManager || lead.assignedAgent || req.user.id,
      property: req.body.property || req.body.propertyId || undefined
    };
    lead.siteVisits.push(newVisit);
    lead.siteVisit = {
      ...newVisit,
      scheduledDate: newVisit.scheduledDate,
      scheduledTime: newVisit.scheduledTime,
      status: 'scheduled',
      relationshipManager: newVisit.relationshipManager,
      property: newVisit.property
    };

    // Update lead status
    if (lead.status === 'qualified' || lead.status === 'contacted' || lead.status === 'new') {
      lead.status = 'site_visit_scheduled';
    }

    // Track Activity
    lead.activityLog.push({
      action: 'site_visit_scheduled',
      details: {
        description: `Site visit scheduled for ${new Date(req.body.scheduledDate).toLocaleDateString()} at ${req.body.scheduledTime}`
      },
      performedBy: req.user.id
    });

    await lead.save();

    // Send site visit confirmation
    try {
      const Agency = require('../models/Agency');
      const User = require('../models/User');

      const agency = await Agency.findById(lead.agency);
      const rm = await User.findById(lead.siteVisit.relationshipManager);

      const leadForEmail = await Lead.findById(lead._id)
        .populate({ path: 'property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } })
        .populate({ path: 'siteVisit.property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } });

      // Send SMS confirmation to lead
      if (lead.contact.phone && agency?.settings?.smsNotifications) {
        await smsService.sendSiteVisitConfirmation(lead);
      }

      // Send email confirmation to lead (with property agent contact details in email)
      if (lead.contact.email) {
        await emailService.sendSiteVisitConfirmation(leadForEmail, rm, agency);
      }

      // Send email to property agent with customer contact details
      const propertyAgent = leadForEmail.siteVisit?.property?.agent || leadForEmail.property?.agent;
      if (propertyAgent && propertyAgent.email) {
        try {
          await emailService.sendSiteVisitNotificationToPropertyAgent(leadForEmail, propertyAgent, agency, 'scheduled');
        } catch (paError) {
          console.error('Error sending site visit email to property agent:', paError);
        }
      }

      // Notify assigned agent about site visit
      if (lead.assignedAgent) {
        const assignedAgent = await User.findById(lead.assignedAgent);
        if (assignedAgent) {
          // Send email notification to agent
          try {
            await emailService.sendSiteVisitNotificationToAgent(lead, assignedAgent, agency);
          } catch (emailError) {
            console.error('Error sending site visit email to agent:', emailError);
          }

          // Send SMS notification to agent if enabled
          if (agency?.settings?.smsNotifications && assignedAgent.phone) {
            try {
              await smsService.sendSiteVisitReminder(lead, assignedAgent);
            } catch (smsError) {
              console.error('Error sending site visit SMS to agent:', smsError);
            }
          }

          // Send lead assignment notification to agent (so lead appears in "My Leads")
          // This is especially important when super admin schedules site visit and agent is auto-assigned
          try {
            const populatedLead = await Lead.findById(lead._id)
              .populate('property', 'title slug')
              .populate('agency', 'name');

            await emailService.sendNewLeadNotification(populatedLead, assignedAgent, agency);

            if (agency?.settings?.smsNotifications && assignedAgent.phone) {
              await smsService.sendLeadNotification(populatedLead, assignedAgent);
            }

            console.log(`✅ Lead assignment notification sent to agent ${assignedAgent._id}`);
          } catch (assignNotifError) {
            console.error('Error sending lead assignment notification to agent:', assignNotifError);
            // Don't fail the request if notification fails
          }
        }
      }

      // Also notify relationship manager if different from assigned agent
      if (rm && rm._id?.toString() !== lead.assignedAgent?.toString()) {
        // Send email notification to relationship manager
        try {
          await emailService.sendSiteVisitNotificationToAgent(lead, rm, agency);
        } catch (emailError) {
          console.error('Error sending site visit email to relationship manager:', emailError);
        }

        // Send SMS notification to relationship manager if enabled
        if (agency?.settings?.smsNotifications && rm.phone) {
          try {
            await smsService.sendSiteVisitReminder(lead, rm);
          } catch (smsError) {
            console.error('Error sending site visit SMS to relationship manager:', smsError);
          }
        }
      }

      // Create auto-reminder for 24 hours before visit
      const reminderDate = new Date(lead.siteVisit.scheduledDate);
      reminderDate.setHours(reminderDate.getHours() - 24);

      if (reminderDate > new Date()) {
        lead.reminders.push({
          title: `Site Visit Reminder - ${lead.contact.firstName} ${lead.contact.lastName}`,
          description: `Reminder: Site visit scheduled for ${new Date(lead.siteVisit.scheduledDate).toLocaleDateString()} at ${lead.siteVisit.scheduledTime}`,
          reminderDate: reminderDate,
          createdBy: req.user.id
        });
        await lead.save();
      }
    } catch (notifError) {
      console.error('Error sending site visit confirmation:', notifError);
      // Don't fail the request if notifications fail
    }

    const updatedLead = await Lead.findById(lead._id)
      .populate('siteVisit.relationshipManager', 'firstName lastName email phone')
      .populate('siteVisit.property', 'title slug')
      .populate('siteVisits.property', 'title slug')
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email phone');

    // Send webhook for site visit scheduling
    if (webhookService.isEnabled()) {
      try {
        await webhookService.sendLeadWebhook(updatedLead, 'site_visit_scheduled');
      } catch (webhookError) {
        console.error('Error sending site visit scheduling webhook:', webhookError);
        // Don't fail the request if webhook fails
      }
    }

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Schedule site visit error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/leads/:id/site-visit/complete
// @desc    Mark site visit as completed
// @access  Private
router.put('/:id/site-visit/complete', auth, checkModulePermission('leads', 'edit'), [
  body('feedback').optional().trim(),
  body('interestLevel').optional({ checkFalsy: true }).trim().isIn(['high', 'medium', 'low', 'not_interested']).withMessage('interestLevel must be one of: high, medium, low, not_interested'),
  body('nextAction').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array(), message: errors.array().map(e => e.msg).join(', ') });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    let visitToComplete = null;
    if (lead.siteVisit && (lead.siteVisit.scheduledDate || lead.siteVisit.status === 'scheduled')) {
      visitToComplete = lead.siteVisit;
    } else if (lead.siteVisits && lead.siteVisits.length) {
      const scheduled = lead.siteVisits.filter(v => v.status === 'scheduled');
      visitToComplete = scheduled.length ? scheduled[scheduled.length - 1] : lead.siteVisits[lead.siteVisits.length - 1];
      if (visitToComplete) lead.siteVisit = visitToComplete;
    }
    if (!visitToComplete) {
      return res.status(400).json({ message: 'No site visit found to complete. Schedule a site visit first.' });
    }

    visitToComplete.status = 'completed';
    visitToComplete.completedDate = new Date();
    if (req.body.feedback) visitToComplete.feedback = req.body.feedback;
    if (req.body.interestLevel) visitToComplete.interestLevel = req.body.interestLevel;
    if (req.body.nextAction) visitToComplete.nextAction = req.body.nextAction;

    // Sync completion into siteVisits array so GET returns consistent data (frontend reads from siteVisits)
    if (lead.siteVisits && Array.isArray(lead.siteVisits)) {
      const visitId = visitToComplete._id ? visitToComplete._id.toString() : null;
      const idx = visitId
        ? lead.siteVisits.findIndex(v => v._id && v._id.toString() === visitId)
        : lead.siteVisits.length - 1;
      if (idx !== -1) {
        lead.siteVisits[idx].status = 'completed';
        lead.siteVisits[idx].completedDate = visitToComplete.completedDate;
        if (req.body.feedback !== undefined) lead.siteVisits[idx].feedback = req.body.feedback;
        if (req.body.interestLevel) lead.siteVisits[idx].interestLevel = req.body.interestLevel;
        if (req.body.nextAction !== undefined) lead.siteVisits[idx].nextAction = req.body.nextAction;
      }
    }

    // Auto-update status
    if (lead.status === 'site_visit_scheduled') {
      lead.status = 'site_visit_completed';
    }

    // Track Activity
    lead.activityLog.push({
      action: 'site_visit_completed',
      details: {
        description: `Site visit completed. Feedback: ${req.body.feedback || 'None'}`
      },
      performedBy: req.user.id
    });

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('siteVisit.relationshipManager', 'firstName lastName')
      .populate('siteVisit.property', 'title slug')
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email phone');

    try {
      const User = require('../models/User');
      const Agency = require('../models/Agency');
      const agency = updatedLead.agency || (await Agency.findById(lead.agency));
      const leadForEmail = await Lead.findById(lead._id)
        .populate({ path: 'property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } })
        .populate({ path: 'siteVisit.property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } });
      const propertyAgent = leadForEmail.siteVisit?.property?.agent || leadForEmail.property?.agent;
      if (leadForEmail.contact?.email) await emailService.sendSiteVisitCompletedToCustomer(leadForEmail, agency, propertyAgent);
      if (updatedLead.assignedAgent) {
        const assignedAgent = await User.findById(updatedLead.assignedAgent);
        if (assignedAgent?.email) await emailService.sendSiteVisitCompletedToAgent(leadForEmail, assignedAgent, agency);
      }
      if (propertyAgent?.email) await emailService.sendSiteVisitNotificationToPropertyAgent(leadForEmail, propertyAgent, agency, 'completed');
    } catch (completeEmailErr) {
      console.error('Error sending site visit completion emails:', completeEmailErr);
    }

    // Send webhook for site visit completion
    if (webhookService.isEnabled()) {
      try {
        await webhookService.sendLeadWebhook(updatedLead, 'site_visit_completed');
      } catch (webhookError) {
        console.error('Error sending site visit completion webhook:', webhookError);
        // Don't fail the request if webhook fails
      }
    }

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Complete site visit error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/leads/:id/site-visit/:visitId
// @desc    Update a particular site visit by id
// @access  Private
router.put('/:id/site-visit/:visitId', auth, checkModulePermission('leads', 'edit'), [
  body('scheduledDate').isISO8601().withMessage('Valid scheduled date is required'),
  body('scheduledTime').trim().notEmpty().withMessage('Scheduled time is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const visitId = req.params.visitId;
    if (!lead.siteVisits || !Array.isArray(lead.siteVisits)) {
      if (lead.siteVisit && lead.siteVisit.scheduledDate) {
        lead.siteVisit.scheduledDate = new Date(req.body.scheduledDate);
        lead.siteVisit.scheduledTime = req.body.scheduledTime;
        if (req.body.property !== undefined || req.body.propertyId !== undefined) {
          lead.siteVisit.property = req.body.property || req.body.propertyId || null;
        }
        await lead.save();
        const updatedLead = await Lead.findById(lead._id)
          .populate('siteVisit.relationshipManager', 'firstName lastName email phone')
          .populate('siteVisit.property', 'title slug')
          .populate('property', 'title slug')
          .populate('agency', 'name')
          .populate('assignedAgent', 'firstName lastName email phone');
        // Send email to customer and assigned agent when visit is updated (with property agent populated)
        try {
          const agency = updatedLead.agency;
          const rm = updatedLead.siteVisit?.relationshipManager;
          if (updatedLead.contact?.email) {
            const leadForEmail = await Lead.findById(updatedLead._id)
              .populate({ path: 'property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } })
              .populate({ path: 'siteVisit.property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } });
            await emailService.sendSiteVisitConfirmation(leadForEmail, rm, agency, true);
          }
          if (updatedLead.assignedAgent) {
            try {
              await emailService.sendSiteVisitNotificationToAgent(updatedLead, updatedLead.assignedAgent, agency, true);
            } catch (emailError) {
              console.error('Error sending site visit update email to agent:', emailError);
            }
          }
          if (rm && rm._id?.toString() !== updatedLead.assignedAgent?._id?.toString()) {
            try {
              await emailService.sendSiteVisitNotificationToAgent(updatedLead, rm, agency, true);
            } catch (emailError) {
              console.error('Error sending site visit update email to relationship manager:', emailError);
            }
          }
          const leadForPa = await Lead.findById(updatedLead._id)
            .populate({ path: 'property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } })
            .populate({ path: 'siteVisit.property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } });
          const propertyAgent = leadForPa.siteVisit?.property?.agent || leadForPa.property?.agent;
          if (propertyAgent?.email) {
            try {
              await emailService.sendSiteVisitNotificationToPropertyAgent(leadForPa, propertyAgent, agency, 'updated');
            } catch (paError) {
              console.error('Error sending site visit update email to property agent:', paError);
            }
          }
        } catch (notifError) {
          console.error('Error sending site visit update emails:', notifError);
        }
        return res.json({ lead: updatedLead });
      }
      return res.status(400).json({ message: 'No site visit found to update' });
    }

    const index = lead.siteVisits.findIndex(v => v._id && v._id.toString() === visitId);
    if (index === -1) {
      return res.status(404).json({ message: 'Site visit not found' });
    }

    lead.siteVisits[index].scheduledDate = new Date(req.body.scheduledDate);
    lead.siteVisits[index].scheduledTime = req.body.scheduledTime;
    if (req.body.property !== undefined || req.body.propertyId !== undefined) {
      lead.siteVisits[index].property = req.body.property || req.body.propertyId || null;
    }
    if (lead.siteVisit && lead.siteVisit._id && lead.siteVisit._id.toString() === visitId) {
      lead.siteVisit.scheduledDate = new Date(req.body.scheduledDate);
      lead.siteVisit.scheduledTime = req.body.scheduledTime;
      if (req.body.property !== undefined || req.body.propertyId !== undefined) {
        lead.siteVisit.property = req.body.property || req.body.propertyId || null;
      }
    }

    lead.activityLog.push({
      action: 'site_visit_updated',
      details: {
        description: `Site visit rescheduled to ${new Date(req.body.scheduledDate).toLocaleDateString()} at ${req.body.scheduledTime}`
      },
      performedBy: req.user.id
    });

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('siteVisit.relationshipManager', 'firstName lastName email phone')
      .populate('siteVisit.property', 'title slug')
      .populate('siteVisits.relationshipManager', 'firstName lastName email phone')
      .populate('siteVisits.property', 'title slug')
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email phone');

    // Send email to customer and assigned agent when visit is updated (with property agent populated)
    try {
      const agency = updatedLead.agency;
      const rm = updatedLead.siteVisit?.relationshipManager;
      if (updatedLead.contact?.email) {
        const leadForEmail = await Lead.findById(updatedLead._id)
          .populate({ path: 'property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } })
          .populate({ path: 'siteVisit.property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } });
        await emailService.sendSiteVisitConfirmation(leadForEmail, rm, agency, true);
      }
      if (updatedLead.assignedAgent) {
        try {
          await emailService.sendSiteVisitNotificationToAgent(updatedLead, updatedLead.assignedAgent, agency, true);
        } catch (emailError) {
          console.error('Error sending site visit update email to agent:', emailError);
        }
      }
      if (rm && rm._id?.toString() !== updatedLead.assignedAgent?._id?.toString()) {
        try {
          await emailService.sendSiteVisitNotificationToAgent(updatedLead, rm, agency, true);
        } catch (emailError) {
          console.error('Error sending site visit update email to relationship manager:', emailError);
        }
      }
      const leadForPa = await Lead.findById(updatedLead._id)
        .populate({ path: 'property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } })
        .populate({ path: 'siteVisit.property', select: 'title slug', populate: { path: 'agent', select: 'firstName lastName email phone' } });
      const propertyAgent = leadForPa.siteVisit?.property?.agent || leadForPa.property?.agent;
      if (propertyAgent?.email) {
        try {
          await emailService.sendSiteVisitNotificationToPropertyAgent(leadForPa, propertyAgent, agency, 'updated');
        } catch (paError) {
          console.error('Error sending site visit update email to property agent:', paError);
        }
      }
    } catch (notifError) {
      console.error('Error sending site visit update emails:', notifError);
    }

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Update site visit error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/leads/:id/site-visit/:visitId/completion
// @desc    Update completion remarks (feedback, interestLevel, nextAction) for a completed visit
// @access  Private
router.put('/:id/site-visit/:visitId/completion', auth, checkModulePermission('leads', 'edit'), [
  body('feedback').optional().trim(),
  body('interestLevel').optional({ checkFalsy: true }).trim().isIn(['high', 'medium', 'low', 'not_interested']).withMessage('interestLevel must be one of: high, medium, low, not_interested'),
  body('nextAction').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array(), message: errors.array().map(e => e.msg).join(', ') });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const visitId = req.params.visitId;
    let visit = null;

    if (lead.siteVisit && lead.siteVisit._id && lead.siteVisit._id.toString() === visitId) {
      visit = lead.siteVisit;
    } else if (lead.siteVisits && Array.isArray(lead.siteVisits)) {
      visit = lead.siteVisits.find(v => v._id && v._id.toString() === visitId);
    }

    if (!visit) {
      return res.status(404).json({ message: 'Site visit not found' });
    }
    if (visit.status !== 'completed') {
      return res.status(400).json({ message: 'Only completed visits can have their remarks updated' });
    }

    if (req.body.feedback !== undefined) visit.feedback = req.body.feedback;
    if (req.body.interestLevel) visit.interestLevel = req.body.interestLevel;
    if (req.body.nextAction !== undefined) visit.nextAction = req.body.nextAction;

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('siteVisit.relationshipManager', 'firstName lastName')
      .populate('siteVisit.property', 'title slug')
      .populate('siteVisits.property', 'title slug')
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email phone');

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Update site visit completion error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/leads/:id/site-visit/:visitId
// @desc    Delete a particular site visit by id
// @access  Private
router.delete('/:id/site-visit/:visitId', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const visitId = req.params.visitId;
    if (!lead.siteVisits || !Array.isArray(lead.siteVisits)) {
      // Backward compat: if only single siteVisit exists, treat as one visit
      if (lead.siteVisit && lead.siteVisit.scheduledDate) {
        lead.siteVisit.status = 'cancelled';
        lead.siteVisit.cancelledDate = new Date();
        lead.siteVisits = [];
        lead.activityLog.push({
          action: 'site_visit_cancelled',
          details: { description: `Site visit scheduled for ${new Date(lead.siteVisit.scheduledDate).toLocaleDateString()} at ${lead.siteVisit.scheduledTime} was cancelled` },
          performedBy: req.user.id
        });
        await lead.save();
        const updatedLead = await Lead.findById(lead._id)
          .populate('siteVisit.relationshipManager', 'firstName lastName email phone')
          .populate('siteVisit.property', 'title slug')
          .populate('property', 'title slug')
          .populate('agency', 'name')
          .populate('assignedAgent', 'firstName lastName email phone');
        try {
          const User = require('../models/User');
          const Agency = require('../models/Agency');
          const Property = require('../models/Property');
          const agency = await Agency.findById(lead.agency);
          const leadForCancel = await Lead.findById(lead._id)
            .populate({ path: 'siteVisit.property', populate: { path: 'agent', select: 'firstName lastName email phone' } })
            .populate({ path: 'property', populate: { path: 'agent', select: 'firstName lastName email phone' } });
          if (leadForCancel.contact?.email) await emailService.sendSiteVisitCancellationToCustomer(leadForCancel, agency);
          if (updatedLead.assignedAgent) {
            const assignedAgent = await User.findById(updatedLead.assignedAgent);
            if (assignedAgent?.email) await emailService.sendSiteVisitCancellationToAgent(leadForCancel, assignedAgent, agency);
          }
          const propertyAgent = leadForCancel.siteVisit?.property?.agent || leadForCancel.property?.agent;
          if (propertyAgent?.email) await emailService.sendSiteVisitNotificationToPropertyAgent(leadForCancel, propertyAgent, agency, 'cancelled');
        } catch (cancelEmailErr) {
          console.error('Error sending site visit cancellation emails:', cancelEmailErr);
        }
        return res.json({ lead: updatedLead });
      }
      return res.status(400).json({ message: 'No site visit found to delete' });
    }

    const index = lead.siteVisits.findIndex(v => v._id && v._id.toString() === visitId);
    if (index === -1) {
      return res.status(404).json({ message: 'Site visit not found' });
    }

    const removed = lead.siteVisits[index];
    lead.siteVisits.splice(index, 1);
    if (lead.siteVisit && lead.siteVisit._id && lead.siteVisit._id.toString() === visitId) {
      lead.siteVisit = lead.siteVisits.length > 0 ? lead.siteVisits[lead.siteVisits.length - 1] : undefined;
    } else if (lead.siteVisits.length > 0 && !lead.siteVisit) {
      lead.siteVisit = lead.siteVisits[lead.siteVisits.length - 1];
    } else if (lead.siteVisits.length === 0) {
      lead.siteVisit = undefined;
    }

    lead.activityLog.push({
      action: 'site_visit_cancelled',
      details: {
        description: `Site visit scheduled for ${new Date(removed.scheduledDate).toLocaleDateString()} at ${removed.scheduledTime} was deleted`
      },
      performedBy: req.user.id
    });

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('siteVisit.relationshipManager', 'firstName lastName email phone')
      .populate('siteVisit.property', 'title slug')
      .populate('siteVisits.relationshipManager', 'firstName lastName email phone')
      .populate('siteVisits.property', 'title slug')
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email phone');

    try {
      const User = require('../models/User');
      const Agency = require('../models/Agency');
      const Property = require('../models/Property');
      const agency = await Agency.findById(lead.agency);
      const removedProperty = removed.property
        ? await Property.findById(removed.property).populate('agent', 'firstName lastName email phone')
        : null;
      const leadForCancel = {
        contact: lead.contact,
        siteVisit: {
          scheduledDate: removed.scheduledDate,
          scheduledTime: removed.scheduledTime,
          property: removedProperty ? { title: removedProperty.title } : null
        },
        property: removedProperty ? { title: removedProperty.title } : (lead.property || {}),
        agency
      };
      if (lead.contact?.email) await emailService.sendSiteVisitCancellationToCustomer(leadForCancel, agency, removedProperty?.agent);
      if (updatedLead.assignedAgent) {
        const assignedAgent = await User.findById(updatedLead.assignedAgent);
        if (assignedAgent?.email) await emailService.sendSiteVisitCancellationToAgent(leadForCancel, assignedAgent, agency);
      }
      if (removedProperty?.agent?.email) await emailService.sendSiteVisitNotificationToPropertyAgent(leadForCancel, removedProperty.agent, agency, 'cancelled');
    } catch (cancelEmailErr) {
      console.error('Error sending site visit cancellation emails:', cancelEmailErr);
    }

    if (webhookService.isEnabled()) {
      try {
        await webhookService.sendLeadWebhook(updatedLead, 'site_visit_cancelled');
      } catch (webhookError) {
        console.error('Error sending site visit cancellation webhook:', webhookError);
      }
    }

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Delete site visit error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/leads/:id/site-visit
// @desc    Cancel the primary site visit (backward compat when no visitId)
// @access  Private
router.delete('/:id/site-visit', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    if (!lead.siteVisit || !lead.siteVisit.scheduledDate) {
      return res.status(400).json({ message: 'No site visit found to cancel' });
    }

    lead.siteVisit.status = 'cancelled';
    lead.siteVisit.cancelledDate = new Date();

    lead.activityLog.push({
      action: 'site_visit_cancelled',
      details: {
        description: `Site visit scheduled for ${new Date(lead.siteVisit.scheduledDate).toLocaleDateString()} at ${lead.siteVisit.scheduledTime} was cancelled`
      },
      performedBy: req.user.id
    });

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('siteVisit.relationshipManager', 'firstName lastName email phone')
      .populate('siteVisit.property', 'title slug')
      .populate('siteVisits.property', 'title slug')
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email phone');

    try {
      const User = require('../models/User');
      const Agency = require('../models/Agency');
      const leadForCancel = await Lead.findById(lead._id)
        .populate({ path: 'siteVisit.property', populate: { path: 'agent', select: 'firstName lastName email phone' } })
        .populate({ path: 'property', populate: { path: 'agent', select: 'firstName lastName email phone' } })
        .populate('agency', 'name');
      const agency = leadForCancel.agency && typeof leadForCancel.agency === 'object' ? leadForCancel.agency : await Agency.findById(lead.agency);
      if (leadForCancel.contact?.email) await emailService.sendSiteVisitCancellationToCustomer(leadForCancel, agency);
      if (updatedLead.assignedAgent) {
        const assignedAgent = await User.findById(updatedLead.assignedAgent);
        if (assignedAgent?.email) await emailService.sendSiteVisitCancellationToAgent(leadForCancel, assignedAgent, agency);
      }
      const propertyAgent = leadForCancel.siteVisit?.property?.agent || leadForCancel.property?.agent;
      if (propertyAgent?.email) await emailService.sendSiteVisitNotificationToPropertyAgent(leadForCancel, propertyAgent, agency, 'cancelled');
    } catch (cancelEmailErr) {
      console.error('Error sending site visit cancellation emails:', cancelEmailErr);
    }

    if (webhookService.isEnabled()) {
      try {
        await webhookService.sendLeadWebhook(updatedLead, 'site_visit_cancelled');
      } catch (webhookError) {
        console.error('Error sending site visit cancellation webhook:', webhookError);
      }
    }

    res.json({ lead: updatedLead });
  } catch (error) {
    console.error('Cancel site visit error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/:id/recurring-followup
// @desc    Enable recurring follow-ups for a lead
// @access  Private
router.post('/:id/recurring-followup', auth, checkModulePermission('leads', 'edit'), [
  body('interval').isInt({ min: 1, max: 365 }).withMessage('Interval must be between 1 and 365 days')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const interval = parseInt(req.body.interval) || 7; // Default 7 days
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + interval);

    lead.recurringFollowUp = {
      enabled: true,
      interval: interval,
      nextFollowUpDate: nextDate,
      count: 0
    };

    await lead.save();
    res.json({ lead });
  } catch (error) {
    console.error('Enable recurring follow-up error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/leads/analytics/dashboard-metrics
// @desc    Get dashboard metrics with filters and breakdown
// @access  Private
router.get('/analytics/dashboard-metrics', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const filter = {};

    // Role-based filtering with explicit ObjectId casting for aggregation
    if (req.user.role === 'agency_admin') {
      filter.agency = mongoose.Types.ObjectId.isValid(req.user.agency) ? new mongoose.Types.ObjectId(req.user.agency) : req.user.agency;
    } else if (req.user.role === 'agent') {
      filter.assignedAgent = mongoose.Types.ObjectId.isValid(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : req.user.id;
    } else if (req.user.role === 'staff') {
      if (req.user.agency) {
        filter.agency = mongoose.Types.ObjectId.isValid(req.user.agency) ? new mongoose.Types.ObjectId(req.user.agency) : req.user.agency;
      }
    }

    // Apply query filters if provided with explicit ObjectId casting for aggregation
    if (req.query.agency && req.user.role === 'super_admin') {
      filter.agency = mongoose.Types.ObjectId.isValid(req.query.agency) ? new mongoose.Types.ObjectId(req.query.agency) : req.query.agency;
    }
    if (req.query.owner) {
      filter.assignedAgent = mongoose.Types.ObjectId.isValid(req.query.owner) ? new mongoose.Types.ObjectId(req.query.owner) : req.query.owner;
    }
    if (req.query.source) {
      filter.source = req.query.source;
    }
    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.property) {
      filter.property = mongoose.Types.ObjectId.isValid(req.query.property) ? new mongoose.Types.ObjectId(req.query.property) : req.query.property;
    }
    if (req.query.campaign) {
      filter.campaignName = new RegExp(req.query.campaign, 'i');
    }
    if (req.query.team) {
      filter.team = req.query.team;
    }
    if (req.query.reportingManager) {
      filter.reportingManager = mongoose.Types.ObjectId.isValid(req.query.reportingManager) ? new mongoose.Types.ObjectId(req.query.reportingManager) : req.query.reportingManager;
    }

    // Date range filtering (for global metrics)
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        filter.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        const endDate = new Date(req.query.endDate);
        endDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = endDate;
      }
    }

    // Calculate dates for special metrics
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

    // Use aggregation for status-based metrics to reduce DB calls
    const statsAggregation = await Lead.aggregate([
      { $match: filter },
      {
        $facet: {
          statusCounts: [
            { $group: { _id: '$status', count: { $sum: 1 } } }
          ],
          sourceCounts: [
            { $group: { _id: '$source', count: { $sum: 1 } } }
          ],
          totalLeads: [{ $count: "count" }]
        }
      }
    ]);

    const stats = statsAggregation[0];
    const totalLeads = stats.totalLeads[0]?.count || 0;

    // Status counts map
    const countsMap = {};
    stats.statusCounts.forEach(s => countsMap[s._id] = s.count);

    const convertedLeadsSet = (countsMap['booked'] || 0) + (countsMap['closed'] || 0);
    const conversionRate = totalLeads > 0 ? ((convertedLeadsSet / totalLeads) * 100).toFixed(2) : 0;

    // Get New Leads Today & This Month (ignores query date filter but respects other filters)
    const baseFilterWithoutDates = { ...filter };
    delete baseFilterWithoutDates.createdAt;

    const timeMetrics = await Lead.aggregate([
      { $match: baseFilterWithoutDates },
      {
        $facet: {
          newToday: [
            { $match: { createdAt: { $gte: startOfToday, $lte: endOfToday } } },
            { $count: "count" }
          ],
          newThisMonth: [
            { $match: { createdAt: { $gte: startOfMonth } } },
            { $count: "count" }
          ],
          todaysFollowUps: [
            { $match: { followUpDate: { $gte: startOfToday, $lte: endOfToday } } },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                completed: {
                  $sum: {
                    $cond: [{ $in: ['$status', ['booked', 'closed', 'site_visit_completed']] }, 1, 0]
                  }
                },
                pending: {
                  $sum: {
                    $cond: [{ $in: ['$status', activeStatuses] }, 1, 0]
                  }
                }
              }
            }
          ],
          missedFollowUps: [
            {
              $match: {
                followUpDate: { $lt: startOfToday },
                status: { $in: activeStatuses }
              }
            },
            { $count: "count" }
          ]
        }
      }
    ]);

    const tMetrics = timeMetrics[0];
    const newLeadsToday = tMetrics.newToday[0]?.count || 0;
    const newLeadsThisMonth = tMetrics.newThisMonth[0]?.count || 0;
    const missedFollowUps = tMetrics.missedFollowUps[0]?.count || 0;
    const followUps = tMetrics.todaysFollowUps[0] || { total: 0, completed: 0, pending: 0 };

    res.json({
      metrics: {
        totalLeads,
        newLeadsToday,
        newLeadsThisMonth,
        conversionRate,
        missedFollowUps,
        statusCounts: countsMap,
        todaysFollowUps: {
          total: followUps.total,
          completed: followUps.completed,
          pending: followUps.pending,
          completionRate: followUps.total > 0
            ? ((followUps.completed / followUps.total) * 100).toFixed(1)
            : 0
        }
      }
    });
  } catch (error) {
    console.error('Dashboard metrics error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   PUT /api/leads/:id/entry-permissions
// @desc    Update entry-specific permissions for a lead
// @access  Private (Super Admin)
router.put('/:id/entry-permissions', auth, authorize('super_admin'), async (req, res) => {
  try {
    const { entryPermissions } = req.body;

    // Validate entryPermissions structure
    if (!entryPermissions) {
      return res.status(400).json({ message: 'entryPermissions is required' });
    }

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { $set: { entryPermissions } },
      { new: true, runValidators: true }
    );

    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    res.json(lead);
  } catch (error) {
    console.error('Update entry permissions error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// @route   GET /api/leads/analytics/advanced
// @desc    Get advanced analytics with comparisons and predictions
// @access  Private
router.get('/analytics/advanced', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const filter = {};

    // Role-based filtering
    if (req.user.role === 'agency_admin') {
      filter.agency = req.user.agency;
    }

    // Date range filtering
    const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
    const startDate = req.query.startDate ? new Date(req.query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default 30 days

    filter.createdAt = {
      $gte: startDate,
      $lte: endDate
    };

    // Get all leads in date range
    const leads = await Lead.find(filter)
      .populate('assignedAgent', 'firstName lastName')
      .populate('property', 'price')
      .populate('booking', 'bookingAmount');

    // Calculate time periods for comparison
    const periodLength = Math.ceil((endDate - startDate) / (2 * 24 * 60 * 60 * 1000)); // Half period in days
    const previousStartDate = new Date(startDate.getTime() - (endDate - startDate));
    const previousEndDate = startDate;

    const previousLeads = await Lead.find({
      ...filter,
      createdAt: {
        $gte: previousStartDate,
        $lte: previousEndDate
      }
    })
      .populate('assignedAgent', 'firstName lastName')
      .populate('property', 'price')
      .populate('booking', 'bookingAmount');

    // Current period metrics
    const currentMetrics = {
      totalLeads: leads.length,
      newLeads: leads.filter(l => l.status === 'new').length,
      convertedLeads: leads.filter(l => l.status === 'booked' || l.status === 'closed').length,
      totalRevenue: leads.reduce((sum, l) => {
        return sum + (l.booking?.bookingAmount || l.property?.price || 0);
      }, 0),
      averageLeadValue: 0,
      conversionRate: 0,
      sourceBreakdown: {},
      agentPerformance: {}
    };

    // Previous period metrics
    const previousMetrics = {
      totalLeads: previousLeads.length,
      newLeads: previousLeads.filter(l => l.status === 'new').length,
      convertedLeads: previousLeads.filter(l => l.status === 'booked' || l.status === 'closed').length,
      totalRevenue: previousLeads.reduce((sum, l) => {
        return sum + (l.booking?.bookingAmount || l.property?.price || 0);
      }, 0),
      averageLeadValue: 0,
      conversionRate: 0
    };

    // Calculate conversion rates
    currentMetrics.conversionRate = currentMetrics.totalLeads > 0
      ? (currentMetrics.convertedLeads / currentMetrics.totalLeads * 100)
      : 0;
    previousMetrics.conversionRate = previousMetrics.totalLeads > 0
      ? (previousMetrics.convertedLeads / previousMetrics.totalLeads * 100)
      : 0;

    // Calculate average lead values
    currentMetrics.averageLeadValue = currentMetrics.convertedLeads > 0
      ? (currentMetrics.totalRevenue / currentMetrics.convertedLeads)
      : 0;
    previousMetrics.averageLeadValue = previousMetrics.convertedLeads > 0
      ? (previousMetrics.totalRevenue / previousMetrics.convertedLeads)
      : 0;

    // Source breakdown
    leads.forEach(lead => {
      const source = lead.source || 'unknown';
      if (!currentMetrics.sourceBreakdown[source]) {
        currentMetrics.sourceBreakdown[source] = {
          total: 0,
          converted: 0,
          revenue: 0
        };
      }
      currentMetrics.sourceBreakdown[source].total++;
      if (lead.status === 'booked' || lead.status === 'closed') {
        currentMetrics.sourceBreakdown[source].converted++;
        currentMetrics.sourceBreakdown[source].revenue += (lead.booking?.bookingAmount || lead.property?.price || 0);
      }
    });

    // Agent performance
    leads.forEach(lead => {
      if (lead.assignedAgent) {
        const agentId = lead.assignedAgent._id.toString();
        if (!currentMetrics.agentPerformance[agentId]) {
          currentMetrics.agentPerformance[agentId] = {
            agentName: `${lead.assignedAgent.firstName} ${lead.assignedAgent.lastName}`,
            totalLeads: 0,
            convertedLeads: 0,
            revenue: 0,
            conversionRate: 0
          };
        }
        currentMetrics.agentPerformance[agentId].totalLeads++;
        if (lead.status === 'booked' || lead.status === 'closed') {
          currentMetrics.agentPerformance[agentId].convertedLeads++;
          currentMetrics.agentPerformance[agentId].revenue += (lead.booking?.bookingAmount || lead.property?.price || 0);
        }
      }
    });

    // Calculate agent conversion rates
    Object.keys(currentMetrics.agentPerformance).forEach(agentId => {
      const agent = currentMetrics.agentPerformance[agentId];
      agent.conversionRate = agent.totalLeads > 0
        ? (agent.convertedLeads / agent.totalLeads * 100)
        : 0;
    });

    // Calculate trends (percentage change)
    const trends = {
      totalLeads: previousMetrics.totalLeads > 0
        ? (((currentMetrics.totalLeads - previousMetrics.totalLeads) / previousMetrics.totalLeads) * 100).toFixed(2)
        : currentMetrics.totalLeads > 0 ? 100 : 0,
      conversionRate: previousMetrics.conversionRate > 0
        ? (((currentMetrics.conversionRate - previousMetrics.conversionRate) / previousMetrics.conversionRate) * 100).toFixed(2)
        : currentMetrics.conversionRate > 0 ? 100 : 0,
      revenue: previousMetrics.totalRevenue > 0
        ? (((currentMetrics.totalRevenue - previousMetrics.totalRevenue) / previousMetrics.totalRevenue) * 100).toFixed(2)
        : currentMetrics.totalRevenue > 0 ? 100 : 0
    };

    // Predictions (simple linear projection)
    const predictions = {
      nextPeriodLeads: Math.round(currentMetrics.totalLeads * (1 + (parseFloat(trends.totalLeads) / 100))),
      nextPeriodRevenue: Math.round(currentMetrics.totalRevenue * (1 + (parseFloat(trends.revenue) / 100))),
      nextPeriodConversions: Math.round(currentMetrics.convertedLeads * (1 + (parseFloat(trends.conversionRate) / 100)))
    };

    res.json({
      currentPeriod: {
        startDate: startDate,
        endDate: endDate,
        metrics: currentMetrics
      },
      previousPeriod: {
        startDate: previousStartDate,
        endDate: previousEndDate,
        metrics: previousMetrics
      },
      trends: trends,
      predictions: predictions,
      sourceBreakdown: Object.entries(currentMetrics.sourceBreakdown).map(([source, data]) => ({
        source,
        total: data.total,
        converted: data.converted,
        revenue: data.revenue,
        conversionRate: data.total > 0 ? ((data.converted / data.total) * 100).toFixed(2) : 0
      })).sort((a, b) => b.revenue - a.revenue),
      agentPerformance: Object.values(currentMetrics.agentPerformance)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10) // Top 10 agents
    });
  } catch (error) {
    console.error('Advanced analytics error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/leads/analytics/campaign-roi
// @desc    Get campaign ROI analysis report
// @access  Private
router.get('/analytics/campaign-roi', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const filter = {};

    // Role-based filtering
    if (req.user.role === 'agency_admin') {
      filter.agency = req.user.agency;
    }

    // Date range filtering
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        filter.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.createdAt.$lte = new Date(req.query.endDate);
      }
    }

    // Get all leads with campaign names
    const leads = await Lead.find({
      ...filter,
      campaignName: { $exists: true, $ne: null, $ne: '' }
    })
      .populate('property', 'price')
      .populate('booking', 'bookingAmount');

    // Group by campaign
    const campaignData = {};

    leads.forEach(lead => {
      const campaign = lead.campaignName || 'Unknown';
      if (!campaignData[campaign]) {
        campaignData[campaign] = {
          campaignName: campaign,
          totalLeads: 0,
          convertedLeads: 0,
          totalRevenue: 0,
          averageLeadValue: 0,
          conversionRate: 0,
          leads: []
        };
      }

      campaignData[campaign].totalLeads++;

      // Check if converted (booked or closed)
      if (lead.status === 'booked' || lead.status === 'closed') {
        campaignData[campaign].convertedLeads++;

        // Calculate revenue
        let revenue = 0;
        if (lead.booking?.bookingAmount) {
          revenue = lead.booking.bookingAmount;
        } else if (lead.property?.price) {
          revenue = lead.property.price;
        }
        campaignData[campaign].totalRevenue += revenue;
      }

      campaignData[campaign].leads.push({
        _id: lead._id,
        leadId: lead.leadId,
        name: `${lead.contact.firstName} ${lead.contact.lastName}`,
        status: lead.status,
        revenue: lead.booking?.bookingAmount || lead.property?.price || 0,
        createdAt: lead.createdAt
      });
    });

    // Calculate metrics for each campaign
    const campaigns = Object.values(campaignData).map(campaign => {
      campaign.conversionRate = campaign.totalLeads > 0
        ? ((campaign.convertedLeads / campaign.totalLeads) * 100).toFixed(2)
        : 0;
      campaign.averageLeadValue = campaign.convertedLeads > 0
        ? (campaign.totalRevenue / campaign.convertedLeads).toFixed(2)
        : 0;

      // ROI calculation (assuming campaign cost is stored separately, for now using lead count as proxy)
      // In real implementation, you'd fetch campaign costs from a campaigns table
      campaign.estimatedROI = campaign.totalRevenue > 0
        ? ((campaign.totalRevenue - (campaign.totalLeads * 100)) / (campaign.totalLeads * 100) * 100).toFixed(2)
        : 0;

      return campaign;
    }).sort((a, b) => b.totalRevenue - a.totalRevenue);

    const totalLeads = leads.length;
    const totalConverted = leads.filter(l => l.status === 'booked' || l.status === 'closed').length;
    const totalRevenue = campaigns.reduce((sum, c) => sum + parseFloat(c.totalRevenue), 0);

    res.json({
      campaigns,
      summary: {
        totalCampaigns: campaigns.length,
        totalLeads,
        totalConverted,
        totalRevenue: totalRevenue.toFixed(2),
        overallConversionRate: totalLeads > 0 ? ((totalConverted / totalLeads) * 100).toFixed(2) : 0,
        averageRevenuePerConversion: totalConverted > 0 ? (totalRevenue / totalConverted).toFixed(2) : 0
      }
    });
  } catch (error) {
    console.error('Campaign ROI analysis error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/leads/analytics/lost-reasons
// @desc    Get lost reason analysis report
// @access  Private
router.get('/analytics/lost-reasons', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const filter = {};

    // Role-based filtering
    if (req.user.role === 'agency_admin') {
      filter.agency = req.user.agency;
    }

    // Date range filtering
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        filter.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.createdAt.$lte = new Date(req.query.endDate);
      }
    }

    // Get lost leads with reasons
    const lostLeads = await Lead.find({
      ...filter,
      status: 'lost',
      lostReason: { $exists: true, $ne: null, $ne: '' }
    });

    // Analyze lost reasons
    const reasonAnalysis = {};
    lostLeads.forEach(lead => {
      const reason = lead.lostReason || 'Not specified';
      if (!reasonAnalysis[reason]) {
        reasonAnalysis[reason] = {
          reason: reason,
          count: 0,
          percentage: 0,
          leads: []
        };
      }
      reasonAnalysis[reason].count++;
      reasonAnalysis[reason].leads.push({
        _id: lead._id,
        leadId: lead.leadId,
        name: `${lead.contact.firstName} ${lead.contact.lastName}`,
        email: lead.contact.email,
        phone: lead.contact.phone,
        createdAt: lead.createdAt,
        lostAt: lead.updatedAt
      });
    });

    // Calculate percentages
    const total = lostLeads.length;
    const analysis = Object.values(reasonAnalysis).map(item => ({
      ...item,
      percentage: total > 0 ? ((item.count / total) * 100).toFixed(2) : 0
    })).sort((a, b) => b.count - a.count);

    res.json({
      total: total,
      analysis: analysis,
      summary: {
        totalLostLeads: total,
        totalWithReasons: lostLeads.filter(l => l.lostReason).length,
        topReason: analysis.length > 0 ? analysis[0] : null
      }
    });
  } catch (error) {
    console.error('Lost reason analysis error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/:id/auto-stage
// @desc    Trigger auto stage movement check
// @access  Private
router.post('/:id/auto-stage', auth, checkModulePermission('leads', 'edit'), async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    const previousStatus = lead.status;

    // Auto stage movement logic
    // 1. If site visit completed with high interest -> move to negotiation
    if (lead.status === 'site_visit_completed' && lead.siteVisit?.interestLevel === 'high') {
      lead.status = 'negotiation';
    }

    // 2. If negotiation and booking details added -> move to booked
    if (lead.status === 'negotiation' && lead.booking?.bookingAmount) {
      lead.status = 'booked';
      lead.convertedAt = new Date();
    }

    // 3. If contacted multiple times but no progress -> check for qualification
    if (lead.status === 'contacted' && lead.communications && lead.communications.length >= 3) {
      // Check if lead has shown interest (has property inquiry, budget, etc.)
      if (lead.property || (lead.inquiry?.budget && lead.inquiry.budget.min)) {
        lead.status = 'qualified';
      }
    }

    // 4. If site visit scheduled but not completed after scheduled date + 1 day -> mark as no-show
    if (lead.status === 'site_visit_scheduled' && lead.siteVisit?.scheduledDate) {
      const scheduledDate = new Date(lead.siteVisit.scheduledDate);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      if (scheduledDate < tomorrow && lead.siteVisit.status === 'scheduled') {
        // Check if visit was completed
        if (!lead.siteVisit.completedDate) {
          lead.siteVisit.status = 'no_show';
        }
      }
    }

    await lead.save();

    const updatedLead = await Lead.findById(lead._id)
      .populate('property', 'title slug')
      .populate('assignedAgent', 'firstName lastName');

    res.json({
      lead: updatedLead,
      statusChanged: previousStatus !== lead.status,
      previousStatus,
      newStatus: lead.status
    });
  } catch (error) {
    console.error('Auto stage movement error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/leads/webhook/send-all
// @desc    Send all leads to external webhook (bulk export)
// @access  Private (super_admin only)
router.post('/webhook/send-all', auth, authorize('super_admin'), async (req, res) => {
  try {
    const { status, agency, startDate, endDate, limit } = req.body;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (agency) {
      if (mongoose.Types.ObjectId.isValid(agency)) {
        filter.agency = new mongoose.Types.ObjectId(agency);
      }
    }
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        const [year, month, day] = startDate.split('-').map(Number);
        filter.createdAt.$gte = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      }
      if (endDate) {
        const [year, month, day] = endDate.split('-').map(Number);
        filter.createdAt.$lte = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
      }
    }

    // Fetch all leads with proper population
    const maxLimit = limit && limit <= 10000 ? parseInt(limit) : 10000;
    const leads = await Lead.find(filter)
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .populate('assignedAgent', 'firstName lastName email')
      .sort('-createdAt')
      .limit(maxLimit);

    if (leads.length === 0) {
      return res.status(404).json({ message: 'No leads found to send' });
    }

    // Send bulk webhook
    if (!webhookService.isEnabled()) {
      return res.status(400).json({
        message: 'Webhook not configured. Please set OUTBOUND_WEBHOOK_URL in environment variables.'
      });
    }

    const result = await webhookService.sendBulkLeadsWebhook(leads, 'bulk_export');

    if (result.success) {
      res.json({
        success: true,
        message: `Successfully sent ${leads.length} leads to webhook`,
        totalLeads: leads.length,
        webhookResponse: result.response
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send leads to webhook',
        error: result.error,
        totalLeads: leads.length
      });
    }
  } catch (error) {
    console.error('Bulk webhook send error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

module.exports = router;

