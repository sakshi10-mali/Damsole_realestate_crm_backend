const express = require('express');
const { body, validationResult, param } = require('express-validator');
const mongoose = require('mongoose');
const User = require('../models/User');
const UserPermission = require('../models/UserPermission');
const Lead = require('../models/Lead');
const Transaction = require('../models/Transaction');
const Property = require('../models/Property');
const { auth, authorize, checkModulePermission } = require('../middleware/auth');
const emailService = require('../services/emailService');
const Agency = require('../models/Agency');

const router = express.Router();

// @route   POST /api/users
// @desc    Create new user
// @access  Private (Super Admin only)
router.post('/', [
  auth,
  checkModulePermission('users', 'create'),
  body('firstName').trim().notEmpty().withMessage('First name is required'),
  body('lastName').trim().notEmpty().withMessage('Last name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').optional().isIn(['super_admin', 'agency_admin', 'agent', 'staff', 'user']).withMessage('Invalid role'),
  body('phone').optional().trim(),
  body('address').optional(),
  body('agency').optional(),
  body('isActive').optional().isBoolean().withMessage('isActive must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const {
      firstName,
      lastName,
      email,
      password,
      phone,
      address,
      role = 'user',
      agency,
      isActive = true
    } = req.body;

    // Agency Admin/Agent/Staff restrictions
    if (['agency_admin', 'agent', 'staff'].includes(req.user.role)) {
      // Non-super admins cannot create super admins
      if (role === 'super_admin') {
        return res.status(403).json({ message: 'You do not have permission to create super admins' });
      }

      // Agency admins cannot create other agency admins (usually)
      if (req.user.role === 'agency_admin' && role === 'agency_admin') {
        return res.status(403).json({ message: 'Agency admins cannot create other agency admins' });
      }

      // Force agency to be their own
      if (agency && agency !== req.user.agency.toString()) {
        return res.status(403).json({ message: 'You can only create users for your own agency' });
      }
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists' });
    }

    // Create new user
    const userData = {
      firstName,
      lastName,
      email,
      password,
      phone,
      address,
      role,
      agency: ['agency_admin', 'agent', 'staff'].includes(req.user.role) ? req.user.agency : (agency || null),
      isActive
    };

    const user = new User(userData);
    await user.save();

    // Return user without password
    const userResponse = user.toObject();
    delete userResponse.password;

    // Send welcome email with credentials in background
    setImmediate(async () => {
      try {
        console.log('📧 Attempting to send account creation email to:', user.email);
        const agencyData = user.agency ? await Agency.findById(user.agency).select('name') : null;
        const userWithAgency = user.toObject();
        userWithAgency.agency = agencyData;

        console.log('📧 User data prepared for email:', {
          email: userWithAgency.email,
          role: userWithAgency.role,
          agency: agencyData?.name || 'No agency'
        });

        await emailService.sendAccountCreatedNotification(userWithAgency, password);
        console.log('✅ Account creation email sent successfully to:', user.email);
      } catch (emailError) {
        console.error('❌ Error sending account creation email:', emailError);
        console.error('❌ Error details:', {
          message: emailError.message,
          stack: emailError.stack
        });
      }
    });

    res.status(201).json({
      message: 'User created successfully',
      user: userResponse
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users
// @desc    Get all users with filtering
// @access  Private (Super Admin, Agency Admin)
router.get('/', [
  auth,
  checkModulePermission('users', 'view')
], async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const {
      role,
      search,
      isActive,
      agency,
      department,
      startDate,
      endDate,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build filter object
    const filter = {};

    if (role) {
      filter.role = role;
    }

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    if (department) {
      filter['staffInfo.department'] = department;
    }

    // Date range filtering
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        // Set to end of day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // Agency filtering - if agency query param is provided, use it (for super_admin and staff)
    if (agency && (req.user.role === 'super_admin' || req.user.role === 'staff')) {
      if (mongoose.Types.ObjectId.isValid(agency)) {
        filter.agency = new mongoose.Types.ObjectId(agency);
      } else {
        filter.agency = agency;
      }
    } else if (req.user.role === 'agency_admin') {
      // Agency admin: only agents/users created or added by this agency
      const agencyId = req.user.agency;
      if (agencyId && mongoose.Types.ObjectId.isValid(agencyId)) {
        filter.agency = new mongoose.Types.ObjectId(agencyId);
      } else {
        filter.agency = agencyId;
      }
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const users = await User.find(filter)
      .select('-password')
      .populate('agency', 'name')
      .sort(sort)
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments(filter);

    res.json({
      users,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/stats/overview
// @desc    Get user statistics
// @access  Private (Super Admin only)
router.get('/stats/overview', [
  auth,
  authorize('super_admin')
], async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const usersByRole = await User.aggregate([
      {
        $group: {
          _id: '$role',
          count: { $sum: 1 }
        }
      }
    ]);

    const recentUsers = await User.find()
      .select('firstName lastName email role createdAt')
      .sort({ createdAt: -1 })
      .limit(5);

    res.json({
      totalUsers,
      activeUsers,
      inactiveUsers: totalUsers - activeUsers,
      usersByRole,
      recentUsers
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/:id/permissions
// @desc    Get permissions for a specific user (super_admin only)
// @access  Private
router.get('/:id/permissions', auth, authorize('super_admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('firstName lastName email role');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    let userPermission = await UserPermission.findOne({ user: req.params.id });
    if (!userPermission) {
      userPermission = new UserPermission({ user: req.params.id });
      await userPermission.save();
    }
    res.json(userPermission);
  } catch (error) {
    console.error('Get user permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/users/:id/permissions
// @desc    Update permissions for a specific user (super_admin only)
// @access  Private
router.put('/:id/permissions', auth, authorize('super_admin'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    const { permissions } = req.body;
    let userPermission = await UserPermission.findOne({ user: req.params.id });
    if (userPermission) {
      userPermission.permissions = permissions;
      userPermission.lastUpdatedBy = req.user.id;
      await userPermission.save();
    } else {
      userPermission = new UserPermission({
        user: req.params.id,
        permissions: permissions || {},
        lastUpdatedBy: req.user.id
      });
      await userPermission.save();
    }
    res.json(userPermission);
  } catch (error) {
    console.error('Update user permissions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/:id/confirmed-properties
// @desc    Get properties the customer has confirmed (completed transactions) with documents per property (for user view Documents tab)
// @access  Private
router.get('/:id/confirmed-properties', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('email').lean();
    if (!user || !user.email) {
      return res.status(404).json({ message: 'User not found or has no email' });
    }
    const emailRegex = new RegExp('^' + (user.email || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    const customerLeads = await Lead.find({ 'contact.email': emailRegex })
      .select('_id property documents')
      .populate('property', 'title slug location')
      .populate('documents.uploadedBy', 'firstName lastName')
      .lean();
    const leadIds = customerLeads.map((l) => l._id);
    const completedTransactions = await Transaction.find({
      lead: { $in: leadIds },
      status: 'completed'
    })
      .populate('property', 'title slug location')
      .sort({ transactionDate: -1 })
      .lean();
    const seenPropertyIds = new Set();
    const confirmedProperties = [];
    for (const tx of completedTransactions) {
      if (!tx.property || !tx.property._id) continue;
      const propId = tx.property._id.toString();
      if (seenPropertyIds.has(propId)) continue;
      seenPropertyIds.add(propId);
      const docsWithLeadId = [];
      let primaryLeadId = null;
      for (const lead of customerLeads) {
        const leadPropId = (lead.property && (lead.property._id || lead.property)) && (lead.property._id || lead.property).toString();
        if (leadPropId !== propId) continue;
        if (!primaryLeadId) primaryLeadId = lead._id;
        const docs = lead.documents || [];
        docs.forEach((doc) => {
          docsWithLeadId.push({ leadId: lead._id, doc });
        });
      }
      // Use transaction's lead if no matching lead found - ensures docs go to correct property
      const txLeadId = tx.lead?._id || tx.lead;
      const effectiveLeadId = primaryLeadId || txLeadId || null;
      if (!effectiveLeadId) continue; // Skip if we can't determine the correct lead
      confirmedProperties.push({
        property: tx.property,
        propertyKey: propId,
        primaryLeadId: effectiveLeadId,
        documents: docsWithLeadId,
        isCurrentLead: true
      });
    }
    res.json({ confirmedProperties });
  } catch (error) {
    console.error('Get confirmed properties error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/users/:id
// @desc    Get single user
// @access  Private
router.get('/:id', [
  auth,
  param('id').custom((value) => {
    if (!value) {
      throw new Error('User ID is required');
    }
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new Error('Invalid user ID format');
    }
    return true;
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Additional safety check
    if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    console.log('🔍 Fetching user with ID:', req.params.id);

    const user = await User.findById(req.params.id)
      .select('-password')
      .populate('agency', 'name logo');

    console.log('👤 User found:', user ? `${user.firstName} ${user.lastName}` : 'NOT FOUND');

    if (!user) {
      console.log('❌ User not found for ID:', req.params.id);
      return res.status(404).json({ message: 'User not found' });
    }

    // Check access permissions
    // Get user agency ID (handle both populated object and ID string)
    let targetUserAgencyId = null;
    if (user.agency) {
      if (user.agency._id) {
        targetUserAgencyId = user.agency._id.toString();
      } else if (typeof user.agency === 'string' || (user.agency.toString && typeof user.agency.toString === 'function')) {
        targetUserAgencyId = user.agency.toString();
      } else {
        targetUserAgencyId = user.agency;
      }
    }

    // Get requesting user agency ID (handle both populated object and ID string)
    let requestingUserAgencyId = null;
    if (req.user.agency) {
      if (req.user.agency._id) {
        requestingUserAgencyId = req.user.agency._id.toString();
      } else if (typeof req.user.agency === 'string' || (req.user.agency.toString && typeof req.user.agency.toString === 'function')) {
        requestingUserAgencyId = req.user.agency.toString();
      } else {
        requestingUserAgencyId = req.user.agency;
      }
    }

    // Super admin can view any user
    if (req.user.role === 'super_admin') {
      return res.json(user);
    }

    // Users can view their own profile
    if (req.user.id === req.params.id) {
      return res.json(user);
    }

    // Agency admin can view users from their agency
    if (req.user.role === 'agency_admin') {
      if (requestingUserAgencyId && targetUserAgencyId === requestingUserAgencyId) {
        return res.json(user);
      }
    }

    // Check if user has users.view permission (for user management)
    const UserPermission = require('../models/UserPermission');
    const userPermission = await UserPermission.findOne({ user: req.user.id });
    if (userPermission && userPermission.permissions?.users?.view) {
      return res.json(user);
    }

    // Check if user has leads.view permission (for viewing user details from leads context)
    if (userPermission && userPermission.permissions?.leads?.view) {
      return res.json(user);
    }

    // All other cases: deny access
    console.log('❌ Access denied for user:', req.user.id, 'to view user:', req.params.id);
    return res.status(403).json({ message: 'Not authorized to view this user' });
  } catch (error) {
    console.error('Get user error:', error);
    // Handle CastError (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/users/:id
// @desc    Update user
// @access  Private
router.put('/:id', [
  auth,
  param('id').custom((value) => {
    if (!value) {
      throw new Error('User ID is required');
    }
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new Error('Invalid user ID format');
    }
    return true;
  }),
  body('firstName').optional().trim().notEmpty(),
  body('lastName').optional().trim().notEmpty(),
  body('email').optional().isEmail().normalizeEmail(),
  body('phone').optional().trim(),
  body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('address').optional(),
  body('isActive').optional().isBoolean()
], async (req, res) => {
  try {
    const { id } = req.params;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.warn('Update user validation failed:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    // 1. Fetch user first
    const user = await User.findById(id).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const oldRole = user.role;

    // 2. Permission logic
    const isSelf = req.user.id === id;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin';

    // Get user agency ID safely
    const targetUserAgencyId = user.agency?._id ? user.agency._id.toString() : (user.agency?.toString() || user.agency);
    const requestingUserAgencyId = req.user.agency; // Already a string or null from auth middleware

    if (isAgencyAdmin) {
      // Agency admin can only update users in their agency
      if (targetUserAgencyId !== requestingUserAgencyId) {
        return res.status(403).json({ message: 'Not authorized to update this user (Agency Mismatch)' });
      }
      // Agency admin cannot change role to super_admin
      if (req.body.role === 'super_admin') {
        delete req.body.role;
      }
    } else if (!isSuperAdmin && !isSelf) {
      return res.status(403).json({ message: 'Not authorized to update this user' });
    }

    // 3. Filter and Prepare Update Data
    // We explicitly pick fields to avoid any illegal fields like _id, __v, etc.
    const allowedFields = ['firstName', 'lastName', 'email', 'phone', 'isActive', 'role', 'agency', 'address', 'staffInfo', 'agentInfo', 'tasks', 'reminders', 'notes', 'activityLog'];
    const updateData = {};

    Object.keys(req.body).forEach(key => {
      if (allowedFields.includes(key) && req.body[key] !== undefined) {
        updateData[key] = req.body[key];
      }
    });

    // Special handling for role
    if (!isSuperAdmin && updateData.role) {
      delete updateData.role;
    }

    // Special handling for password
    let passwordUpdated = false;
    if (req.body.password) {
      const canChangePassword = isSuperAdmin || (isAgencyAdmin && targetUserAgencyId === requestingUserAgencyId) || isSelf;
      if (canChangePassword) {
        user.password = req.body.password;
        passwordUpdated = true;
      }
    }

    // 4. Perform Update
    if (passwordUpdated) {
      // If password changed, we must use .save() to trigger pre-save hook
      Object.entries(updateData).forEach(([key, value]) => {
        if (key === 'address' && value && typeof value === 'object') {
          // Flatten address update to avoid subdocument spreading issues
          Object.entries(value).forEach(([addrKey, addrVal]) => {
            if (addrKey !== '_id') { // Prevent setting _id
              user.address[addrKey] = addrVal;
            }
          });
        } else if (key === 'staffInfo' || key === 'agentInfo') {
          if (value && typeof value === 'object') {
            user[key] = { ...user[key], ...value };
          }
        } else {
          user[key] = value;
        }
      });
      await user.save();
    } else {
      // Otherwise use findByIdAndUpdate for better performance
      // Ensure we don't try to update immutable fields
      delete updateData._id;
      delete updateData.__v;

      await User.findByIdAndUpdate(id, { $set: updateData }, { runValidators: true });
    }

    // 5. Return updated user
    const finalUser = await User.findById(id).select('-password').populate('agency', 'name');

    res.json({
      message: 'User updated successfully',
      user: finalUser
    });

    // 6. Notifications in background
    setImmediate(async () => {
      try {
        if (updateData.role && updateData.role !== oldRole) {
          await emailService.sendRoleChangeNotification(finalUser, oldRole, updateData.role);
        } else {
          await emailService.sendProfileUpdateNotification(finalUser);
        }
      } catch (emailError) {
        console.error('Error sending update notification email:', emailError);
      }
    });

  } catch (error) {
    console.error('Update user error:', error);
    // Handle CastError (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    // Handle Duplicate Key Error (MongoDB error code 11000)
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'field';
      return res.status(400).json({ message: `User with this ${field} already exists` });
    }
    // Handle Mongoose Validation Error
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ message: messages.join(', ') });
    }
    res.status(500).json({
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// @route   PUT /api/users/:id/status
// @desc    Update user status (activate/deactivate)
// @access  Private (Super Admin, Agency Admin)
router.put('/:id/status', [
  auth,
  checkModulePermission('users', 'edit'),
  param('id').custom((value) => {
    if (!value) {
      throw new Error('User ID is required');
    }
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new Error('Invalid user ID format');
    }
    return true;
  }),
  body('isActive').isBoolean().withMessage('isActive must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Additional safety check
    if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Agency admin can only update users from their agency
    if (req.user.role === 'agency_admin' && user.agency?.toString() !== req.user.agency) {
      return res.status(403).json({
        message: 'Not authorized to update this user status'
      });
    }

    user.isActive = req.body.isActive;
    await user.save();

    res.json({
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      user: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Update user status error:', error);
    // Handle CastError (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/users/:id
// @desc    Delete user
// @access  Private (Super Admin, Agency Admin, Self)
router.delete('/:id', [
  auth,
  param('id').custom((value) => {
    if (!value) {
      throw new Error('User ID is required');
    }
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new Error('Invalid user ID format');
    }
    return true;
  })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Additional safety check
    if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Authorization Logic
    const isSelf = user._id.toString() === req.user.id;
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin';

    // 1. Allow Self Deletion
    // 2. Allow Super Admin to delete anyone
    // 3. Allow Agency Admin to delete users in their agency (check agency match)

    if (!isSelf && !isSuperAdmin) {
      if (isAgencyAdmin) {
        // Check if target user belongs to the same agency
        if (user.agency?.toString() !== req.user.agency) {
          return res.status(403).json({ message: 'Not authorized to delete this user (Agency Mismatch)' });
        }
      } else {
        // Agents/Staff/Users cannot delete others
        return res.status(403).json({ message: 'Not authorized to delete this user' });
      }
    }

    await User.findByIdAndDelete(req.params.id);

    res.json({
      message: 'User deleted successfully',
      deletedUser: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Delete user error:', error);
    // Handle CastError (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/users/:id/password
// @desc    Change user password
// @access  Private
router.put('/:id/password', [
  auth,
  param('id').custom((value) => {
    if (!value) {
      throw new Error('User ID is required');
    }
    if (!mongoose.Types.ObjectId.isValid(value)) {
      throw new Error('Invalid user ID format');
    }
    return true;
  }),
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Additional safety check
    if (!req.params.id || !mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }

    const user = await User.findById(req.params.id).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check access permissions
    if (req.user.id !== req.params.id) {
      return res.status(403).json({ message: 'Not authorized to change this password' });
    }

    const { currentPassword, newPassword } = req.body;

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    // Send confirmation email in background
    setImmediate(async () => {
      try {
        await emailService.sendPasswordChangeConfirmation(user);
      } catch (emailError) {
        console.error('Error sending password confirmation email:', emailError);
      }
    });

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    // Handle CastError (invalid ObjectId)
    if (error.name === 'CastError') {
      return res.status(400).json({ message: 'Invalid user ID format' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// ==========================================
// TASKS ROUTES
// ==========================================

// @route   POST /api/users/:id/tasks
// @desc    Add new task
// @access  Private
router.post('/:id/tasks', [
  auth,
  param('id').custom((value) => {
    if (!mongoose.Types.ObjectId.isValid(value)) throw new Error('Invalid user ID');
    return true;
  }),
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('dueDate').optional().toDate(),
  body('priority').optional().isIn(['low', 'medium', 'high']),
  body('status').optional().isIn(['pending', 'in_progress', 'completed', 'overdue']),
  body('taskType').optional().isIn(['call', 'email', 'meeting', 'site_visit', 'other'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Authorization
    const isSelf = req.user.id === user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin' &&
      user.agency?.toString() === req.user.agency;

    if (!isSelf && !isSuperAdmin && !isAgencyAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const newTask = {
      title: req.body.title,
      description: req.body.description,
      taskType: req.body.taskType,
      dueDate: req.body.dueDate,
      priority: req.body.priority,
      status: req.body.status,
      createdBy: req.user.id
    };

    user.tasks.push(newTask);
    await user.save();
    res.json(user.tasks);
  } catch (error) {
    console.error('Add task error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/users/:id/tasks/:taskId
// @desc    Update task
// @access  Private
router.put('/:id/tasks/:taskId', [
  auth,
  param('id').custom((value) => mongoose.Types.ObjectId.isValid(value)),
  param('taskId').custom((value) => mongoose.Types.ObjectId.isValid(value))
], async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Authorization
    const isSelf = req.user.id === user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin' &&
      user.agency?.toString() === req.user.agency;

    if (!isSelf && !isSuperAdmin && !isAgencyAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const task = user.tasks.id(req.params.taskId);
    if (!task) return res.status(404).json({ message: 'Task not found' });

    const fields = ['title', 'description', 'taskType', 'dueDate', 'priority', 'status'];
    fields.forEach(field => {
      if (req.body[field] !== undefined) task[field] = req.body[field];
    });

    if (req.body.status === 'completed' && !task.completedAt) {
      task.completedAt = new Date();
    }

    await user.save();
    res.json(user.tasks);
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/users/:id/tasks/:taskId
// @desc    Remove task
// @access  Private
router.delete('/:id/tasks/:taskId', [
  auth,
  param('id').custom((value) => mongoose.Types.ObjectId.isValid(value)),
  param('taskId').custom((value) => mongoose.Types.ObjectId.isValid(value))
], async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Authorization
    const isSelf = req.user.id === user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin' &&
      user.agency?.toString() === req.user.agency;

    if (!isSelf && !isSuperAdmin && !isAgencyAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    user.tasks.pull(req.params.taskId);
    await user.save();
    res.json(user.tasks);
  } catch (error) {
    console.error('Delete task error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==========================================
// REMINDERS ROUTES
// ==========================================

// @route   POST /api/users/:id/reminders
// @desc    Add new reminder
// @access  Private
router.post('/:id/reminders', [
  auth,
  param('id').custom((value) => mongoose.Types.ObjectId.isValid(value)),
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('reminderDate').notEmpty().withMessage('Date is required').toDate()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Authorization
    const isSelf = req.user.id === user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin' &&
      user.agency?.toString() === req.user.agency;

    if (!isSelf && !isSuperAdmin && !isAgencyAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const newReminder = {
      title: req.body.title,
      description: req.body.description,
      reminderDate: req.body.reminderDate,
      isCompleted: req.body.isCompleted || false,
      createdBy: req.user.id
    };

    user.reminders.push(newReminder);
    await user.save();
    res.json(user.reminders);
  } catch (error) {
    console.error('Add reminder error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/users/:id/reminders/:reminderId
// @desc    Update reminder
// @access  Private
router.put('/:id/reminders/:reminderId', [
  auth,
  param('id').custom((value) => mongoose.Types.ObjectId.isValid(value)),
  param('reminderId').custom((value) => mongoose.Types.ObjectId.isValid(value))
], async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Authorization
    const isSelf = req.user.id === user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin' &&
      user.agency?.toString() === req.user.agency;

    if (!isSelf && !isSuperAdmin && !isAgencyAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const reminder = user.reminders.id(req.params.reminderId);
    if (!reminder) return res.status(404).json({ message: 'Reminder not found' });

    if (req.body.title !== undefined) reminder.title = req.body.title;
    if (req.body.description !== undefined) reminder.description = req.body.description;
    if (req.body.reminderDate !== undefined) reminder.reminderDate = req.body.reminderDate;
    if (req.body.isCompleted !== undefined) reminder.isCompleted = req.body.isCompleted;

    await user.save();
    res.json(user.reminders);
  } catch (error) {
    console.error('Update reminder error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/users/:id/reminders/:reminderId
// @desc    Remove reminder
// @access  Private
router.delete('/:id/reminders/:reminderId', [
  auth,
  param('id').custom((value) => mongoose.Types.ObjectId.isValid(value)),
  param('reminderId').custom((value) => mongoose.Types.ObjectId.isValid(value))
], async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Authorization
    const isSelf = req.user.id === user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin' &&
      user.agency?.toString() === req.user.agency;

    if (!isSelf && !isSuperAdmin && !isAgencyAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    user.reminders.pull(req.params.reminderId);
    await user.save();
    res.json(user.reminders);
  } catch (error) {
    console.error('Delete reminder error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==========================================
// NOTES ROUTES
// ==========================================

// @route   POST /api/users/:id/notes
// @desc    Add new note
// @access  Private
router.post('/:id/notes', [
  auth,
  param('id').custom((value) => mongoose.Types.ObjectId.isValid(value)),
  body('note').trim().notEmpty().withMessage('Note content is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Authorization
    const isSelf = req.user.id === user._id.toString();
    const isSuperAdmin = req.user.role === 'super_admin';
    const isAgencyAdmin = req.user.role === 'agency_admin' &&
      user.agency?.toString() === req.user.agency;

    if (!isSelf && !isSuperAdmin && !isAgencyAdmin) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const newNote = {
      note: req.body.note,
      createdBy: req.user.id
    };

    user.notes.push(newNote);
    await user.save();
    res.json(user.notes);
  } catch (error) {
    console.error('Add note error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
