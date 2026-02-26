const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  leadId: {
    type: String,
    unique: true,
    sparse: true
  },
  source: {
    type: String,
    enum: ['website', 'phone', 'email', 'walk_in', 'referral', 'social_media', 'other'],
    default: 'website'
  },
  campaignName: {
    type: String,
    trim: true
  },
  property: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Property'
  },
  interestedProperties: [{
    property: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Property'
    },
    action: {
      type: String,
      enum: ['inquiry', 'viewing', 'booked', 'sold', 'rented'],
      default: 'inquiry'
    },
    date: {
      type: Date,
      default: Date.now
    }
  }],
  contact: {
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true
    },
    phone: {
      type: String,
      required: [true, 'Phone is required'],
      trim: true
    },
    alternatePhone: String,
    address: {
      street: String,
      city: String,
      state: String,
      country: String,
      zipCode: String
    }
  },
  inquiry: {
    message: String,
    budget: {
      min: Number,
      max: Number,
      currency: {
        type: String,
        default: 'USD'
      }
    },
    preferredLocation: [String],
    propertyType: [String],
    timeline: {
      type: String,
      enum: ['immediate', '1_month', '3_months', '6_months', '1_year', 'flexible']
    },
    requirements: String,
    projectName: String,
    bhk: String,
    size: String,
    purpose: {
      type: String,
      enum: ['investment', 'self_use', 'both']
    }
  },
  status: {
    type: String,
    enum: ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation', 'booked', 'lost', 'closed', 'junk'],
    default: 'new'
  },
  priority: {
    type: String,
    enum: ['Hot', 'Warm', 'Cold', 'Not_interested'],
    default: 'Warm'
  },
  agency: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agency',
    required: [true, 'Agency is required']
  },
  assignedAgent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reportingManager: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    // Manager who oversees this lead (usually agency_admin or team lead)
  },
  team: {
    type: String,
    trim: true
    // Team name/identifier for team-wise visibility
  },
  notes: [{
    note: {
      type: String,
      required: true
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  communications: [{
    type: {
      type: String,
      enum: ['call', 'email', 'sms', 'meeting', 'note'],
      required: true
    },
    subject: String,
    message: String,
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      default: 'outbound'
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  tasks: [{
    title: {
      type: String,
      required: true
    },
    description: String,
    taskType: {
      type: String,
      enum: ['call_back', 'site_visit', 'meeting', 'document_collection', 'payment_reminder', 'other'],
      default: 'other'
    },
    dueDate: Date,
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'cancelled'],
      default: 'pending'
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    completedAt: Date,
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  followUpDate: Date,
  reminders: [{
    title: {
      type: String,
      required: true
    },
    description: String,
    reminderDate: {
      type: Date,
      required: true
    },
    isCompleted: {
      type: Boolean,
      default: false
    },
    completedAt: Date,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  convertedAt: Date,
  lostReason: String,
  tags: [String],
  isApproved: {
    type: Boolean,
    default: false
  },
  // SLA Tracking
  sla: {
    firstContactAt: Date,
    firstContactSla: {
      type: Number,
      default: 3600000 // 1 hour in milliseconds
    },
    firstContactStatus: {
      type: String,
      enum: ['pending', 'met', 'breached'],
      default: 'pending'
    },
    responseTime: Number, // Time in milliseconds from creation to first contact
    lastContactAt: Date
  },
  // Lead Scoring
  score: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  scoreDetails: {
    sourceScore: Number,
    budgetScore: Number,
    timelineScore: Number,
    engagementScore: Number,
    lastCalculatedAt: Date
  },
  // Recurring Follow-ups
  recurringFollowUp: {
    enabled: {
      type: Boolean,
      default: false
    },
    interval: {
      type: Number, // Days between follow-ups
      default: 7
    },
    nextFollowUpDate: Date,
    count: {
      type: Number,
      default: 0
    }
  },
  siteVisit: {
    scheduledDate: Date,
    scheduledTime: String,
    completedDate: Date,
    cancelledDate: Date,
    status: {
      type: String,
      enum: ['scheduled', 'completed', 'no_show', 'cancelled'],
      default: 'scheduled'
    },
    feedback: String,
    interestLevel: {
      type: String,
      enum: ['high', 'medium', 'low', 'not_interested']
    },
    nextAction: String,
    relationshipManager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' }
  },
  // Multiple site visits per lead (use this for listing and deleting a particular visit)
  siteVisits: [{
    scheduledDate: Date,
    scheduledTime: String,
    completedDate: Date,
    cancelledDate: Date,
    status: {
      type: String,
      enum: ['scheduled', 'completed', 'no_show', 'cancelled'],
      default: 'scheduled'
    },
    feedback: String,
    interestLevel: { type: String, enum: ['high', 'medium', 'low', 'not_interested'] },
    nextAction: String,
    relationshipManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' }
  }],
  booking: {
    unitNumber: String,
    flatNumber: String,
    bookingAmount: Number,
    paymentMode: {
      type: String,
      enum: ['cash', 'cheque', 'online', 'bank_transfer', 'other']
    },
    agreementStatus: {
      type: String,
      enum: ['pending', 'draft', 'signed', 'completed']
    },
    bookingDate: Date
  },
  documents: [{
    name: String,
    url: String,
    type: {
      type: String,
      enum: ['pdf', 'doc', 'docx', 'image']
    },
    size: Number,
    filename: String,
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    uploadedAt: {
      type: Date,
      default: Date.now
    }
  }],
  // GDPR Compliance
  gdprConsent: {
    marketing: {
      consented: Boolean,
      recordedAt: Date,
      recordedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      ipAddress: String
    },
    data_processing: {
      consented: Boolean,
      recordedAt: Date,
      recordedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      ipAddress: String
    },
    communication: {
      consented: Boolean,
      recordedAt: Date,
      recordedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      ipAddress: String
    }
  },
  gdprDeleted: {
    deletedAt: Date,
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: String
  },
  // ERP Integration
  erpSync: [{
    erpSystem: {
      type: String,
      enum: ['sap', 'oracle', 'tally', 'quickbooks', 'xero', 'custom']
    },
    erpRecordId: String,
    syncedAt: Date,
    syncedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  entryPermissions: {
    agency_admin: {
      view: { type: Boolean, default: true },
      edit: { type: Boolean, default: true },
      delete: { type: Boolean, default: false }
    },
    agent: {
      view: { type: Boolean, default: true },
      edit: { type: Boolean, default: true },
      delete: { type: Boolean, default: false }
    },
    staff: {
      view: { type: Boolean, default: true },
      edit: { type: Boolean, default: true },
      delete: { type: Boolean, default: false }
    }
  },
  // Activity Log / Audit Trail
  activityLog: [{
    action: {
      type: String,
      required: true,
      enum: [
        'status_change',
        'priority_change',
        'assignment_change',
        'note_added',
        'communication_added',
        'task_added',
        'reminder_added',
        'document_uploaded',
        'site_visit_scheduled',
        'site_visit_completed',
        'site_visit_cancelled',
        'site_visit_updated',
        'lead_created',
        'lead_updated',
        'merged',
        'document_deleted',
        'task_updated',
        'task_deleted',
        'reminder_updated',
        'reminder_deleted'
      ]
    },
    details: {
      field: String,
      oldValue: mongoose.Schema.Types.Mixed,
      newValue: mongoose.Schema.Types.Mixed,
      description: String
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Auto-generate leadId before saving
leadSchema.pre('save', async function (next) {
  if (!this.leadId) {
    try {
      // Find the highest existing leadId number
      const Lead = mongoose.model('Lead');
      const lastLead = await Lead.findOne({ leadId: { $exists: true, $ne: null } })
        .sort({ leadId: -1 })
        .select('leadId');

      let nextNumber = 1;
      if (lastLead && lastLead.leadId) {
        // Extract number from leadId (e.g., "LEAD-000054" -> 54)
        const match = lastLead.leadId.match(/\d+$/);
        if (match) {
          nextNumber = parseInt(match[0], 10) + 1;
        }
      }

      // Generate new leadId and check for uniqueness
      let attempts = 0;
      let newLeadId;
      do {
        newLeadId = `LEAD-${String(nextNumber).padStart(6, '0')}`;
        const exists = await Lead.findOne({ leadId: newLeadId });
        if (!exists) {
          this.leadId = newLeadId;
          break;
        }
        nextNumber++;
        attempts++;
        // Safety check to prevent infinite loop
        if (attempts > 100) {
          // Fallback to timestamp-based ID if too many conflicts
          this.leadId = `LEAD-${Date.now().toString().slice(-6)}`;
          break;
        }
      } while (true);
    } catch (error) {
      console.error('Error generating leadId:', error);
      // Fallback to timestamp-based ID on error
      this.leadId = `LEAD-${Date.now().toString().slice(-6)}`;
    }
  }
  next();
});

// Indexes
leadSchema.index({ 'contact.email': 1, 'contact.phone': 1 });
leadSchema.index({ status: 1, priority: 1 });
leadSchema.index({ agency: 1, assignedAgent: 1 });
leadSchema.index({ property: 1 });
leadSchema.index({ followUpDate: 1 });
leadSchema.index({ 'siteVisit.scheduledDate': 1 });
leadSchema.index({ 'booking.bookingDate': 1 });
leadSchema.index({ campaignName: 1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ team: 1 });
leadSchema.index({ reportingManager: 1 });
leadSchema.index({ agency: 1, team: 1 }); // Compound index for team filtering
leadSchema.index({ agency: 1, createdAt: -1 }); // For agency-based date filtering
leadSchema.index({ status: 1, createdAt: -1 }); // For status-based date filtering
leadSchema.index({ source: 1, createdAt: -1 }); // For source-based reports

module.exports = mongoose.model('Lead', leadSchema);

