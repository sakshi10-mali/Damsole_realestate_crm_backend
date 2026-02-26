const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    required: true, // Required but auto-generated from name
    unique: true,
    lowercase: true,
    trim: true
  },
  subject: {
    type: String,
    required: true
  },
  htmlContent: {
    type: String,
    required: true
  },
  textContent: {
    type: String
  },
  category: {
    type: String,
    enum: ['lead', 'property', 'user', 'system', 'notification', 'other'],
    default: 'other'
  },
  variables: [{
    name: String,
    description: String,
    example: String
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Generate slug before saving
emailTemplateSchema.pre('save', function(next) {
  // Always ensure slug is set - generate from name if not provided
  if (!this.slug || this.isModified('name')) {
    if (this.name && this.name.trim()) {
      let generatedSlug = this.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      
      // Ensure slug is not empty
      if (generatedSlug && generatedSlug.length > 0) {
        this.slug = generatedSlug;
      } else {
        // Fallback: use timestamp if name doesn't generate valid slug
        this.slug = `template-${Date.now()}`;
      }
    } else if (!this.slug) {
      // If no name and no slug, generate a fallback
      this.slug = `template-${Date.now()}`;
    }
  }
  
  // Ensure slug is always set (required for unique index)
  if (!this.slug) {
    this.slug = `template-${Date.now()}`;
  }
  
  next();
});

// Indexes
emailTemplateSchema.index({ category: 1 });
emailTemplateSchema.index({ isActive: 1 });

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);

