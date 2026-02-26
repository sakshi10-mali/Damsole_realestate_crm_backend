const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
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
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false // Don't include password by default in queries
  },
  role: {
    type: String,
    enum: ['super_admin', 'agency_admin', 'agent', 'staff', 'user'],
    required: [true, 'Role is required']
  },
  agency: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agency',
    // Agency is optional during registration, can be assigned later by admin
  },
  team: {
    type: String,
    trim: true
    // Team name/identifier for team-wise visibility
  },
  isTeamLead: {
    type: Boolean,
    default: false
    // Whether this user is a team lead/manager
  },
  phone: {
    type: String,
    trim: true
  },
  address: {
    street: String,
    city: String,
    state: String,
    country: String,
    zipCode: String
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  profileImage: {
    type: String
  },
  // Agent specific fields
  agentInfo: {
    licenseNumber: String,
    bio: String,
    specialties: [String],
    languages: [String],
    yearsOfExperience: Number,
    commissionRate: {
      type: Number,
      min: 0,
      max: 100
    },
    totalSales: {
      type: Number,
      default: 0
    },
    totalLeads: {
      type: Number,
      default: 0
    },
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0
    }
  },
  // Staff specific fields
  staffInfo: {
    department: {
      type: String,
      enum: ['accounts', 'hr', 'support', 'marketing', 'other']
    },
    position: String,
    employeeId: String
  },
  // Privacy & GDPR compliance
  privacyConsent: {
    given: {
      type: Boolean,
      default: false
    },
    date: Date,
    version: String
  },
  // Embedded Arrays for User Management
  tasks: [{
    title: { type: String, required: true },
    description: String,
    taskType: {
      type: String,
      enum: ['call', 'email', 'meeting', 'site_visit', 'other'],
      default: 'other'
    },
    dueDate: Date,
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'overdue'],
      default: 'pending'
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
    completedAt: Date
  }],
  reminders: [{
    title: { type: String, required: true },
    description: String,
    reminderDate: { type: Date, required: true },
    isCompleted: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
  }],
  notes: [{
    note: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
  }],
  activityLog: [{
    action: { type: String, required: true },
    details: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    timestamp: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!candidatePassword || !this.password) {
    console.error('comparePassword: Missing password or candidatePassword');
    return false;
  }
  try {
    const result = await bcrypt.compare(candidatePassword, this.password);
    return result;
  } catch (error) {
    console.error('Password comparison error:', error);
    return false;
  }
};

// Get full name
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Remove password from JSON output
userSchema.methods.toJSON = function () {
  const user = this.toObject();
  delete user.password;
  return user;
};

module.exports = mongoose.model('User', userSchema);
