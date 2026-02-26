const express = require('express');
const { body, validationResult } = require('express-validator');
const Blog = require('../models/Blog');
const Page = require('../models/Page');
const Banner = require('../models/Banner');
const Category = require('../models/Category');
const Amenity = require('../models/Amenity');
const Testimonial = require('../models/Testimonial');
const ContactMessage = require('../models/ContactMessage');
const Footer = require('../models/Footer');
const Agency = require('../models/Agency');
const Script = require('../models/Script');
const User = require('../models/User');
const Lead = require('../models/Lead');
const emailService = require('../services/emailService');
const leadScoringService = require('../services/leadScoringService');
const { auth, authorize, optionalAuth, checkModulePermission } = require('../middleware/auth');

const router = express.Router();

// ==================== BLOGS ====================

// @route   GET /api/cms/blogs
// @desc    Get all blogs
// @access  Public (with optional auth for admin access)
router.get('/blogs', optionalAuth, async (req, res) => {
  try {
    const filter = {};
    // Only show published blogs to non-admin users
    // Admins (super_admin, agency_admin) can see all blogs including drafts
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.status = 'published';
    }

    const limit = parseInt(req.query.limit) || (req.user && (req.user.role === 'super_admin' || req.user.role === 'agency_admin') ? 100 : 10);

    const blogs = await Blog.find(filter)
      .populate('author', 'firstName lastName profileImage')
      .populate('category', 'name slug')
      .sort('-publishedAt -createdAt')
      .limit(limit);

    res.json({ blogs });
  } catch (error) {
    console.error('Get blogs error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/cms/blogs/:slug
// @desc    Get single blog by slug
// @access  Public (published only); admins can see drafts
router.get('/blogs/:slug', optionalAuth, async (req, res) => {
  try {
    const filter = { slug: req.params.slug };
    // Only show published blogs to non-admin users
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.status = 'published';
    }

    const blog = await Blog.findOne(filter)
      .populate('author', 'firstName lastName profileImage')
      .populate('category', 'name slug');

    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    blog.viewCount += 1;
    await blog.save();

    res.json({ blog });
  } catch (error) {
    console.error('Get blog error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/blogs
// @desc    Create blog
// @access  Private (Super Admin, Agency Admin)
router.post('/blogs', auth, checkModulePermission('cms', 'create'), [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('content').notEmpty().withMessage('Content is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Ensure SEO keywords is an array if it's a string
    if (req.body.seo && typeof req.body.seo.keywords === 'string') {
      req.body.seo.keywords = req.body.seo.keywords.split(',').map(k => k.trim()).filter(k => k);
    }

    const blog = new Blog({
      ...req.body,
      author: req.user.id,
      publishedAt: req.body.status === 'published' ? new Date() : null
    });
    await blog.save();

    const populatedBlog = await Blog.findById(blog._id)
      .populate('author', 'firstName lastName')
      .populate('category', 'name slug');

    res.status(201).json({ blog: populatedBlog });
  } catch (error) {
    console.error('Create blog error:', error);

    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ message: 'Validation error', errors: messages });
    }

    // Handle duplicate slug/title error
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A blog with this title already exists' });
    }

    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/blogs/:id
// @desc    Update blog
// @access  Private
router.put('/blogs/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    Object.assign(blog, req.body);
    if (req.body.status === 'published' && !blog.publishedAt) {
      blog.publishedAt = new Date();
    }
    await blog.save();

    res.json({ blog });
  } catch (error) {
    console.error('Update blog error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/blogs/:id
// @desc    Delete blog
// @access  Private
router.delete('/blogs/:id', auth, checkModulePermission('cms', 'delete'), async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) {
      return res.status(404).json({ message: 'Blog not found' });
    }

    await blog.deleteOne();
    res.json({ message: 'Blog deleted successfully' });
  } catch (error) {
    console.error('Delete blog error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== PAGES ====================

// @route   GET /api/cms/pages
// @desc    Get all pages
// @access  Public (with optional auth for admin access)
router.get('/pages', optionalAuth, async (req, res) => {
  try {
    const filter = {};
    // Only show active pages to non-admin users
    // Admins can see all pages including inactive ones
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.isActive = true;
    }
    const pages = await Page.find(filter).sort('order');
    res.json({ pages });
  } catch (error) {
    console.error('Get pages error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/cms/pages/:slug
// @desc    Get single page by slug
// @access  Public (with optional auth for admin access to inactive pages)
router.get('/pages/:slug', optionalAuth, async (req, res) => {
  try {
    const filter = { slug: req.params.slug };

    // Only show active pages to non-admin users
    // Admins can see all pages including inactive ones
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.isActive = true;
    }

    const page = await Page.findOne(filter);
    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }
    res.json({ page });
  } catch (error) {
    console.error('Get page error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/pages
// @desc    Create page
// @access  Private (Super Admin)
router.post('/pages', auth, checkModulePermission('cms', 'create'), [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('slug').trim().notEmpty().withMessage('Slug is required'),
  body('content').notEmpty().withMessage('Content is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const page = new Page(req.body);
    await page.save();
    res.status(201).json({ page });
  } catch (error) {
    console.error('Create page error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/pages/:id
// @desc    Update page
// @access  Private
router.put('/pages/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const page = await Page.findById(req.params.id);
    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    Object.assign(page, req.body);
    await page.save();
    res.json({ page });
  } catch (error) {
    console.error('Update page error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/pages/:id
// @desc    Delete page
// @access  Private
router.delete('/pages/:id', auth, checkModulePermission('cms', 'delete'), async (req, res) => {
  try {
    const page = await Page.findById(req.params.id);
    if (!page) {
      return res.status(404).json({ message: 'Page not found' });
    }

    await page.deleteOne();
    res.json({ message: 'Page deleted successfully' });
  } catch (error) {
    console.error('Delete page error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== BANNERS ====================

// @route   GET /api/cms/banners
// @desc    Get all banners
// @access  Public (with optional auth for admin access)
router.get('/banners', optionalAuth, async (req, res) => {
  try {
    const filter = {};
    // Only show active banners to non-admin users
    // Admins can see all banners including inactive ones
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.isActive = true;
    }

    if (req.query.position) {
      filter.$or = [
        { position: req.query.position },
        { position: 'all' }
      ];
    }

    const limit = parseInt(req.query.limit) || (req.user && (req.user.role === 'super_admin' || req.user.role === 'agency_admin') ? 100 : 10);

    const banners = await Banner.find(filter)
      .sort('order')
      .limit(limit);

    res.json({ banners });
  } catch (error) {
    console.error('Get banners error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/banners
// @desc    Create banner
// @access  Private (Super Admin)
router.post('/banners', auth, checkModulePermission('cms', 'create'), [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('image').notEmpty().withMessage('Image is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const banner = new Banner(req.body);
    await banner.save();
    res.status(201).json({ banner });
  } catch (error) {
    console.error('Create banner error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/banners/:id
// @desc    Update banner
// @access  Private
router.put('/banners/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ message: 'Banner not found' });
    }

    Object.assign(banner, req.body);
    await banner.save();
    res.json({ banner });
  } catch (error) {
    console.error('Update banner error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/banners/:id
// @desc    Delete banner
// @access  Private
router.delete('/banners/:id', auth, checkModulePermission('cms', 'delete'), async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);
    if (!banner) {
      return res.status(404).json({ message: 'Banner not found' });
    }

    await banner.deleteOne();
    res.json({ message: 'Banner deleted successfully' });
  } catch (error) {
    console.error('Delete banner error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== CATEGORIES ====================

// @route   GET /api/cms/categories
// @desc    Get all categories
// @access  Public (with optional auth for admin access)
router.get('/categories', optionalAuth, async (req, res) => {
  try {
    const filter = {};
    // Only show active categories to non-admin users
    // Admins can see all categories including inactive ones
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.isActive = true;
    }
    const categories = await Category.find(filter).sort('order');
    res.json({ categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/categories
// @desc    Create category
// @access  Private (Super Admin)
router.post('/categories', auth, checkModulePermission('cms', 'create'), [
  body('name').trim().notEmpty().withMessage('Category name is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const category = new Category(req.body);
    await category.save();
    res.status(201).json({ category });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/categories/:id
// @desc    Update category
// @access  Private
router.put('/categories/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    Object.assign(category, req.body);
    await category.save();
    res.json({ category });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/categories/:id
// @desc    Delete category
// @access  Private
router.delete('/categories/:id', auth, checkModulePermission('cms', 'delete'), async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    await category.deleteOne();
    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== AMENITIES ====================

// @route   GET /api/cms/amenities
// @desc    Get all amenities
// @access  Public (with optional auth for admin access)
router.get('/amenities', optionalAuth, async (req, res) => {
  try {
    const filter = {};
    // Only show active amenities to non-admin users
    // Admins can see all amenities including inactive ones
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.isActive = true;
    }
    if (req.query.category) {
      filter.category = req.query.category;
    }
    const amenities = await Amenity.find(filter).sort('order');
    res.json({ amenities });
  } catch (error) {
    console.error('Get amenities error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/amenities
// @desc    Create amenity
// @access  Private (Super Admin)
router.post('/amenities', auth, checkModulePermission('cms', 'create'), [
  body('name').trim().notEmpty().withMessage('Amenity name is required'),
  body('category')
    .optional({ values: 'falsy' })
    .custom((value) => {
      if (!value || value === '') return true; // Allow empty strings
      return ['interior', 'exterior', 'community', 'security', 'other'].includes(value);
    })
    .withMessage('Invalid category')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Clean up the data - only send valid fields
    const amenityData = {
      name: req.body.name.trim(),
      icon: req.body.icon?.trim() || undefined,
      category: req.body.category && req.body.category.trim() && ['interior', 'exterior', 'community', 'security', 'other'].includes(req.body.category.trim())
        ? req.body.category.trim()
        : 'other',
      order: parseInt(req.body.order) || 0,
      isActive: req.body.isActive !== undefined ? Boolean(req.body.isActive) : true
    };

    const amenity = new Amenity(amenityData);
    await amenity.save();
    res.status(201).json({ amenity });
  } catch (error) {
    console.error('Create amenity error:', error);

    // Return more specific error messages
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ message: 'Validation error', errors });
    }

    if (error.code === 11000) {
      // Duplicate key error (unique constraint violation)
      return res.status(400).json({ message: 'An amenity with this name already exists' });
    }

    res.status(500).json({
      message: error.message || 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// @route   PUT /api/cms/amenities/:id
// @desc    Update amenity
// @access  Private
router.put('/amenities/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const amenity = await Amenity.findById(req.params.id);
    if (!amenity) {
      return res.status(404).json({ message: 'Amenity not found' });
    }

    Object.assign(amenity, req.body);
    await amenity.save();
    res.json({ amenity });
  } catch (error) {
    console.error('Update amenity error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/amenities/:id
// @desc    Delete amenity
// @access  Private
router.delete('/amenities/:id', auth, checkModulePermission('cms', 'delete'), async (req, res) => {
  try {
    const amenity = await Amenity.findById(req.params.id);
    if (!amenity) {
      return res.status(404).json({ message: 'Amenity not found' });
    }

    await amenity.deleteOne();
    res.json({ message: 'Amenity deleted successfully' });
  } catch (error) {
    console.error('Delete amenity error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== TESTIMONIALS ====================

// @route   GET /api/cms/testimonials
// @desc    Get all testimonials
// @access  Public (with optional auth for admin access)
router.get('/testimonials', optionalAuth, async (req, res) => {
  try {
    const filter = {};
    // Only show active testimonials to non-admin users
    // Admins can see all testimonials including inactive ones
    if (!req.user || (req.user.role !== 'super_admin' && req.user.role !== 'agency_admin')) {
      filter.isActive = true;
    }
    if (req.query.featured === 'true') {
      filter.isFeatured = true;
    }
    const limit = parseInt(req.query.limit) || (req.user && (req.user.role === 'super_admin' || req.user.role === 'agency_admin') ? 100 : 10);
    const testimonials = await Testimonial.find(filter)
      .populate('property', 'title slug')
      .populate('agency', 'name')
      .sort('-order -createdAt')
      .limit(limit);
    res.json({ testimonials });
  } catch (error) {
    console.error('Get testimonials error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/testimonials
// @desc    Create testimonial
// @access  Private (Super Admin, Agency Admin)
router.post('/testimonials', auth, checkModulePermission('cms', 'create'), [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('role').trim().notEmpty().withMessage('Role is required'),
  body('content').trim().notEmpty().withMessage('Content is required'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const testimonial = new Testimonial(req.body);
    await testimonial.save();
    res.status(201).json({ testimonial });
  } catch (error) {
    console.error('Create testimonial error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/testimonials/:id
// @desc    Update testimonial
// @access  Private
router.put('/testimonials/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const testimonial = await Testimonial.findById(req.params.id);
    if (!testimonial) {
      return res.status(404).json({ message: 'Testimonial not found' });
    }

    Object.assign(testimonial, req.body);
    await testimonial.save();
    res.json({ testimonial });
  } catch (error) {
    console.error('Update testimonial error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/testimonials/:id
// @desc    Delete testimonial
// @access  Private
router.delete('/testimonials/:id', auth, checkModulePermission('cms', 'delete'), async (req, res) => {
  try {
    const testimonial = await Testimonial.findById(req.params.id);
    if (!testimonial) {
      return res.status(404).json({ message: 'Testimonial not found' });
    }

    await testimonial.deleteOne();
    res.json({ message: 'Testimonial deleted successfully' });
  } catch (error) {
    console.error('Delete testimonial error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== CONTACT MESSAGES ====================

// @route   GET /api/cms/contact-messages
// @desc    Get all contact messages
// @access  Private (Dynamic Permissions)
router.get('/contact-messages', auth, checkModulePermission('contact_messages', 'view'), async (req, res) => {
  try {
    const filter = {};

    // Agency admin can only see messages for their agency
    if (req.user.role === 'agency_admin') {
      if (!req.user.agency) {
        return res.status(403).json({ message: 'Agency not assigned to your account' });
      }
      filter.agency = req.user.agency;
    }

    const messages = await ContactMessage.find(filter)
      .populate('agency', 'name logo')
      .sort('-createdAt');

    res.json({ messages });
  } catch (error) {
    console.error('Get contact messages error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/contact-messages
// @desc    Create contact message (public endpoint for contact form)
// @access  Public
router.post('/contact-messages', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('message').trim().notEmpty().withMessage('Message is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Assign message to first active agency (similar to leads)
    let agencyId = req.body.agency;
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

    const contactMessage = new ContactMessage({
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone || '',
      subject: req.body.subject || '',
      message: req.body.message,
      agency: agencyId
    });

    await contactMessage.save();

    const populatedMessage = await ContactMessage.findById(contactMessage._id)
      .populate('agency', 'name logo');

    // Send notifications to Admins
    try {
      const agency = await Agency.findById(agencyId);

      // Get all recipients: Super Admins + Agency Admins for this agency
      const superAdmins = await User.find({ role: 'super_admin', isActive: true });
      const agencyAdmins = await User.find({ role: 'agency_admin', agency: agencyId, isActive: true });

      const recipientEmails = new Set();
      superAdmins.forEach(u => recipientEmails.add(u.email));
      agencyAdmins.forEach(u => recipientEmails.add(u.email));

      const recipientsArray = Array.from(recipientEmails).filter(Boolean);
      if (recipientsArray.length > 0) {
        await emailService.sendContactMessageNotification(populatedMessage, agency, recipientsArray);
      }

      // Send confirmation email to the customer
      await emailService.sendContactConfirmation(populatedMessage);

      // --- Lead Creation Logic ---
      try {
        const firstName = req.body.name.split(' ')[0] || req.body.name;
        const lastName = req.body.name.split(' ').slice(1).join(' ') || '';

        let lead = await Lead.findOne({
          'contact.email': req.body.email.toLowerCase(),
          agency: agencyId
        });

        if (lead) {
          // Update existing lead
          lead.activityLog.push({
            action: 'lead_updated',
            details: { description: 'Contact form submitted (CMS Message)' },
            performedBy: null
          });
          lead.notes.push({
            content: `New CMS contact form submission: ${req.body.message}`,
            createdBy: null,
            createdAt: new Date()
          });
          await lead.save();
        } else {
          // Create new lead
          lead = new Lead({
            agency: agencyId,
            contact: {
              firstName,
              lastName,
              email: req.body.email,
              phone: req.body.phone || ''
            },
            source: 'website',
            status: 'new',
            priority: 'Warm',
            inquiry: {
              message: req.body.message
            },
            activityLog: [{
              action: 'lead_created',
              details: { description: 'Contact form submitted (CMS Message)' },
              performedBy: null
            }],
            sla: {
              firstContactSla: 3600000,
              firstContactStatus: 'pending'
            }
          });
          await lead.save();
          try {
            await leadScoringService.autoScoreLead(lead._id, true);
          } catch (e) { console.error('Auto score error:', e); }
        }
      } catch (leadError) {
        console.error('Error creating lead from CMS message:', leadError);
      }
      // --- End Lead Creation Logic ---

    } catch (notifError) {
      console.error('Error sending contact message notifications:', notifError);
    }

    res.status(201).json({
      message: 'Contact message submitted successfully',
      contactMessage: populatedMessage
    });
  } catch (error) {
    console.error('Create contact message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/contact-messages/:id
// @desc    Delete contact message
// @access  Private (Dynamic Permissions)
router.delete('/contact-messages/:id', auth, checkModulePermission('contact_messages', 'delete'), async (req, res) => {
  try {
    const contactMessage = await ContactMessage.findById(req.params.id);
    if (!contactMessage) {
      return res.status(404).json({ message: 'Contact message not found' });
    }

    // Agency admin can only delete messages from their agency
    if (req.user.role === 'agency_admin') {
      const messageAgencyId = contactMessage.agency.toString();
      const userAgencyId = req.user.agency.toString();
      if (messageAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    await contactMessage.deleteOne();
    res.json({ message: 'Contact message deleted successfully' });
  } catch (error) {
    console.error('Delete contact message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/contact-messages/:id/read
// @desc    Mark contact message as read
// @access  Private (Dynamic Permissions)
router.put('/contact-messages/:id/read', auth, checkModulePermission('contact_messages', 'edit'), async (req, res) => {
  try {
    const contactMessage = await ContactMessage.findById(req.params.id);
    if (!contactMessage) {
      return res.status(404).json({ message: 'Contact message not found' });
    }

    // Agency admin can only mark messages from their agency as read
    if (req.user.role === 'agency_admin') {
      const messageAgencyId = contactMessage.agency.toString();
      const userAgencyId = req.user.agency.toString();
      if (messageAgencyId !== userAgencyId) {
        return res.status(403).json({ message: 'Access denied' });
      }
    }

    contactMessage.isRead = true;
    await contactMessage.save();
    res.json({ contactMessage });
  } catch (error) {
    console.error('Mark message as read error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== FOOTER ====================

// @route   GET /api/cms/footer
// @desc    Get footer data
// @access  Public
router.get('/footer', async (req, res) => {
  try {
    // Footer is a singleton - get the first one or create default
    let footer = await Footer.findOne();
    if (!footer) {
      // Create default footer
      footer = new Footer({
        companyName: 'Damsole',
        companyTagline: 'Realestate CRM',
        description: 'Your trusted partner in finding the perfect property.',
        copyright: '2026 Damsole Technologies. All Rights Reserved. Design and Developed with ♥ Spireleap Innovations',
        additionalContent: ''
      });
      await footer.save();
    }
    res.json({ footer });
  } catch (error) {
    console.error('Get footer error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/footer
// @desc    Create footer data
// @access  Private (Super Admin only)
router.post('/footer', auth, checkModulePermission('cms', 'create'), async (req, res) => {
  try {
    // Check if footer already exists
    const existingFooter = await Footer.findOne();
    if (existingFooter) {
      return res.status(400).json({ message: 'Footer already exists. Use PUT to update.' });
    }

    const footer = new Footer(req.body);
    await footer.save();
    res.status(201).json({ footer });
  } catch (error) {
    console.error('Create footer error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/footer/:id
// @desc    Update footer data
// @access  Private (Super Admin only)
router.put('/footer/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const footer = await Footer.findById(req.params.id);
    if (!footer) {
      return res.status(404).json({ message: 'Footer not found' });
    }

    Object.assign(footer, req.body);
    await footer.save();
    res.json({ footer });
  } catch (error) {
    console.error('Update footer error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/contact-messages/:id/entry-permissions
// @desc    Update entry-specific permissions for a contact message
// @access  Private (Super Admin)
router.put('/contact-messages/:id/entry-permissions', auth, authorize('super_admin'), async (req, res) => {
  try {
    const { entryPermissions } = req.body;

    if (!entryPermissions) {
      return res.status(400).json({ message: 'entryPermissions is required' });
    }

    const contactMessage = await ContactMessage.findByIdAndUpdate(
      req.params.id,
      { $set: { entryPermissions } },
      { new: true, runValidators: true }
    );

    if (!contactMessage) {
      return res.status(404).json({ message: 'Contact message not found' });
    }

    res.json(contactMessage);
  } catch (error) {
    console.error('Update entry permissions error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== SCRIPTS ====================

// @route   GET /api/cms/scripts
// @desc    Get all scripts (admin)
// @access  Private (CMS View)
router.get('/scripts', auth, checkModulePermission('cms', 'view'), async (req, res) => {
  try {
    const scripts = await Script.find().sort({ createdAt: -1 });
    res.json({ scripts });
  } catch (error) {
    console.error('Get scripts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/cms/scripts/active
// @desc    Get all active scripts (public)
// @access  Public
router.get('/scripts/active', async (req, res) => {
  try {
    const scripts = await Script.find({ isActive: true });
    res.json({ scripts });
  } catch (error) {
    console.error('Get active scripts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/cms/scripts
// @desc    Create a script
// @access  Private (CMS Create)
router.post('/scripts', auth, checkModulePermission('cms', 'create'), async (req, res) => {
  try {
    const script = new Script(req.body);
    await script.save();
    res.status(201).json({ script });
  } catch (error) {
    console.error('Create script error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   PUT /api/cms/scripts/:id
// @desc    Update a script
// @access  Private (CMS Edit)
router.put('/scripts/:id', auth, checkModulePermission('cms', 'edit'), async (req, res) => {
  try {
    const script = await Script.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!script) return res.status(404).json({ message: 'Script not found' });
    res.json({ script });
  } catch (error) {
    console.error('Update script error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/cms/scripts/:id
// @desc    Delete a script
// @access  Private (CMS Delete)
router.delete('/scripts/:id', auth, checkModulePermission('cms', 'delete'), async (req, res) => {
  try {
    const script = await Script.findByIdAndDelete(req.params.id);
    if (!script) return res.status(404).json({ message: 'Script not found' });
    res.json({ message: 'Script deleted successfully' });
  } catch (error) {
    console.error('Delete script error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

