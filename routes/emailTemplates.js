const express = require('express');
const { body, validationResult, query, param } = require('express-validator');
const EmailTemplate = require('../models/EmailTemplate');
const { auth, checkModulePermission } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/email-templates
// @desc    Get all email templates
// @access  Private (CMS view)
router.get('/', auth, checkModulePermission('cms', 'view'), [
  query('category').optional(),
  query('isActive').optional().isBoolean()
], async (req, res) => {
  try {
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

    const templates = await EmailTemplate.find(filter)
      .populate('createdBy', 'firstName lastName')
      .populate('updatedBy', 'firstName lastName')
      .sort({ category: 1, name: 1 });

    res.json({ templates });
  } catch (error) {
    console.error('Get email templates error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/email-templates/:id
// @desc    Get email template by ID
// @access  Private (CMS view)
router.get('/:id', auth, checkModulePermission('cms', 'view'), [
  param('id').isMongoId().withMessage('Invalid template ID')
], async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id)
      .populate('createdBy', 'firstName lastName')
      .populate('updatedBy', 'firstName lastName');

    if (!template) {
      return res.status(404).json({ message: 'Email template not found' });
    }

    res.json({ template });
  } catch (error) {
    console.error('Get email template error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/email-templates/slug/:slug
// @desc    Get email template by slug
// @access  Private (CMS view)
router.get('/slug/:slug', auth, checkModulePermission('cms', 'view'), async (req, res) => {
  try {
    const template = await EmailTemplate.findOne({ slug: req.params.slug });

    if (!template) {
      return res.status(404).json({ message: 'Email template not found' });
    }

    res.json({ template });
  } catch (error) {
    console.error('Get email template by slug error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/email-templates
// @desc    Create email template
// @access  Private (CMS create)
// Helper function to check if HTML content is not empty (ignores empty tags)
const isHtmlContentValid = (html) => {
  if (!html || typeof html !== 'string') return false;
  // Remove HTML tags and check if there's actual text content
  const textContent = html.replace(/<[^>]*>/g, '').trim();
  return textContent.length > 0;
};

router.post('/', [
  auth,
  checkModulePermission('cms', 'create'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('subject').trim().notEmpty().withMessage('Subject is required'),
  body('htmlContent').custom((value) => {
    if (!isHtmlContentValid(value)) {
      throw new Error('HTML content is required and cannot be empty');
    }
    return true;
  }),
  body('category').optional().isIn(['lead', 'property', 'user', 'system', 'notification', 'other'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('Validation errors:', errors.array());
      console.error('Request body:', {
        name: req.body.name,
        subject: req.body.subject,
        htmlContent: req.body.htmlContent ? 'Present' : 'Missing',
        htmlContentLength: req.body.htmlContent?.length || 0,
        category: req.body.category
      });
      return res.status(400).json({ 
        message: 'Validation failed',
        errors: errors.array() 
      });
    }

    // Ensure name is provided and valid
    if (!req.body.name || !req.body.name.trim()) {
      return res.status(400).json({ message: 'Name is required' });
    }

    // Clean HTML content - remove empty tags but keep actual content
    let htmlContent = req.body.htmlContent || '';
    if (typeof htmlContent === 'string') {
      htmlContent = htmlContent.trim();
      // Remove empty paragraph tags and other empty elements
      htmlContent = htmlContent.replace(/<p><br><\/p>/gi, '');
      htmlContent = htmlContent.replace(/<p>\s*<\/p>/gi, '');
    }

    // Generate slug from name before creating document
    const name = req.body.name.trim();
    let slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    
    // Ensure slug is not empty
    if (!slug || slug.length === 0) {
      slug = `template-${Date.now()}`;
    }
    
    // Check if slug already exists and append number if needed
    let finalSlug = slug;
    let counter = 1;
    while (await EmailTemplate.findOne({ slug: finalSlug })) {
      finalSlug = `${slug}-${counter}`;
      counter++;
    }

    const templateData = {
      name: name,
      slug: finalSlug, // Set slug explicitly before validation
      subject: req.body.subject.trim(),
      htmlContent: htmlContent,
      textContent: (req.body.textContent || '').trim(),
      category: req.body.category || 'other',
      variables: req.body.variables || [],
      isActive: req.body.isActive !== undefined ? req.body.isActive : true,
      createdBy: req.user.id,
      updatedBy: req.user.id
    };

    const template = new EmailTemplate(templateData);
    await template.save();

    const populatedTemplate = await EmailTemplate.findById(template._id)
      .populate('createdBy', 'firstName lastName')
      .populate('updatedBy', 'firstName lastName');

    res.status(201).json({ template: populatedTemplate });
  } catch (error) {
    console.error('Create email template error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      keyPattern: error.keyPattern,
      keyValue: error.keyValue,
      errors: error.errors
    });
    
    if (error.code === 11000) {
      return res.status(400).json({ 
        message: 'Template with this name or slug already exists',
        field: Object.keys(error.keyPattern || {})[0]
      });
    }
    
    // Handle validation errors
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

// @route   PUT /api/email-templates/:id
// @desc    Update email template
// @access  Private (CMS edit)
router.put('/:id', [
  auth,
  checkModulePermission('cms', 'edit'),
  param('id').isMongoId().withMessage('Invalid template ID'),
  body('subject').optional().trim().notEmpty(),
  body('htmlContent').optional().trim().notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: 'Email template not found' });
    }

    // If name is being updated, regenerate slug
    if (req.body.name && req.body.name.trim() !== template.name) {
      const name = req.body.name.trim();
      let slug = name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      
      if (!slug || slug.length === 0) {
        slug = `template-${Date.now()}`;
      }
      
      // Check if slug already exists (excluding current template)
      let finalSlug = slug;
      let counter = 1;
      const existingTemplate = await EmailTemplate.findOne({ 
        slug: finalSlug, 
        _id: { $ne: req.params.id } 
      });
      if (existingTemplate) {
        while (await EmailTemplate.findOne({ 
          slug: `${slug}-${counter}`, 
          _id: { $ne: req.params.id } 
        })) {
          counter++;
        }
        finalSlug = `${slug}-${counter}`;
      }
      
      req.body.slug = finalSlug;
    }

    Object.assign(template, req.body);
    template.updatedBy = req.user.id;
    await template.save();

    const updatedTemplate = await EmailTemplate.findById(template._id)
      .populate('createdBy', 'firstName lastName')
      .populate('updatedBy', 'firstName lastName');

    res.json({ template: updatedTemplate });
  } catch (error) {
    console.error('Update email template error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Template with this slug already exists' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/email-templates/:id
// @desc    Delete email template
// @access  Private (CMS delete)
router.delete('/:id', [
  auth,
  checkModulePermission('cms', 'delete'),
  param('id').isMongoId().withMessage('Invalid template ID')
], async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res.status(404).json({ message: 'Email template not found' });
    }

    await EmailTemplate.deleteOne({ _id: req.params.id });
    res.json({ message: 'Email template deleted successfully' });
  } catch (error) {
    console.error('Delete email template error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

