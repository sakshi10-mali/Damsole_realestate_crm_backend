const Activity = require('../models/Activity');

class ActivityService {
  async logActivity(data) {
    try {
      const activity = new Activity({
        type: data.type,
        entityType: data.entityType,
        entityId: data.entityId,
        title: data.title,
        description: data.description,
        metadata: data.metadata || {},
        agency: data.agency,
        performedBy: data.performedBy,
        relatedUsers: data.relatedUsers || []
      });

      await activity.save();
      return activity;
    } catch (error) {
      console.error('Error logging activity:', error);
      // Don't throw error - activity logging should not break main flow
      return null;
    }
  }

  async logLeadActivity(lead, type, user, description, metadata = {}) {
    return this.logActivity({
      type,
      entityType: 'lead',
      entityId: lead._id || lead,
      title: this.getLeadActivityTitle(type, lead),
      description,
      metadata: {
        ...metadata,
        leadStatus: lead.status,
        leadPriority: lead.priority
      },
      agency: lead.agency?._id || lead.agency,
      performedBy: user._id || user,
      relatedUsers: lead.assignedAgent ? [lead.assignedAgent] : []
    });
  }

  async logPropertyActivity(property, type, user, description, metadata = {}) {
    return this.logActivity({
      type,
      entityType: 'property',
      entityId: property._id || property,
      title: this.getPropertyActivityTitle(type, property),
      description,
      metadata: {
        ...metadata,
        propertyStatus: property.status,
        propertyType: property.propertyType
      },
      agency: property.agency?._id || property.agency,
      performedBy: user._id || user,
      relatedUsers: property.agent ? [property.agent] : []
    });
  }

  async logTransactionActivity(transaction, type, user, description, metadata = {}) {
    return this.logActivity({
      type,
      entityType: 'transaction',
      entityId: transaction._id || transaction,
      title: this.getTransactionActivityTitle(type, transaction),
      description,
      metadata: {
        ...metadata,
        transactionStatus: transaction.status,
        transactionAmount: transaction.amount
      },
      agency: transaction.agency?._id || transaction.agency,
      performedBy: user._id || user,
      relatedUsers: transaction.agent ? [transaction.agent] : []
    });
  }

  getLeadActivityTitle(type, lead) {
    const leadName = lead.contact
      ? `${lead.contact.firstName} ${lead.contact.lastName}`
      : 'Lead';

    const titles = {
      'lead_created': `New lead created: ${leadName}`,
      'lead_updated': `Lead updated: ${leadName}`,
      'lead_assigned': `Lead assigned: ${leadName}`,
      'lead_status_changed': `Lead status changed: ${leadName}`,
      'note_added': `Note added to lead: ${leadName}`,
      'communication_logged': `Communication logged for: ${leadName}`,
      'task_created': `Task created for lead: ${leadName}`,
      'task_completed': `Task completed for lead: ${leadName}`
    };

    return titles[type] || `Activity on lead: ${leadName}`;
  }

  getPropertyActivityTitle(type, property) {
    const propertyTitle = property.title || 'Property';

    const titles = {
      'property_created': `Property created: ${propertyTitle}`,
      'property_updated': `Property updated: ${propertyTitle}`,
      'property_approved': `Property approved: ${propertyTitle}`,
      'property_rejected': `Property rejected: ${propertyTitle}`
    };

    return titles[type] || `Activity on property: ${propertyTitle}`;
  }

  getTransactionActivityTitle(type, transaction) {
    const titles = {
      'transaction_created': `Transaction created: ${transaction.amount} ${transaction.currency}`,
      'transaction_updated': `Transaction updated: ${transaction.amount} ${transaction.currency}`
    };

    return titles[type] || `Activity on transaction`;
  }
}

module.exports = new ActivityService();

