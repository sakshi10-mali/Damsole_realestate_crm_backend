const { notifyUser, notifyAgency, notifyRole, notifyAll, emitActivity } = require('../socket');
const Activity = require('../models/Activity');
const activityService = require('./activityService');

class NotificationService {
  /**
   * Send notification to a specific user
   */
  async sendToUser(userId, notification) {
    try {
      const notificationData = {
        id: Date.now().toString(),
        type: notification.type || 'info',
        title: notification.title,
        message: notification.message,
        data: notification.data || {},
        timestamp: new Date(),
        read: false
      };

      notifyUser(userId, notificationData);

      // Log activity if provided
      if (notification.logActivity) {
        await activityService.logActivity({
          type: 'notification_sent',
          entityType: 'user',
          entityId: userId,
          title: notification.title,
          description: notification.message,
          performedBy: notification.senderId || userId,
          metadata: notificationData
        });
      }

      return notificationData;
    } catch (error) {
      console.error('Error sending notification to user:', error);
      throw error;
    }
  }

  /**
   * Send notification to all users in an agency
   */
  async sendToAgency(agencyId, notification) {
    try {
      const notificationData = {
        id: Date.now().toString(),
        type: notification.type || 'info',
        title: notification.title,
        message: notification.message,
        data: notification.data || {},
        timestamp: new Date(),
        read: false
      };

      notifyAgency(agencyId, notificationData);
      return notificationData;
    } catch (error) {
      console.error('Error sending notification to agency:', error);
      throw error;
    }
  }

  /**
   * Send notification to all users with a specific role
   */
  async sendToRole(role, notification) {
    try {
      const notificationData = {
        id: Date.now().toString(),
        type: notification.type || 'info',
        title: notification.title,
        message: notification.message,
        data: notification.data || {},
        timestamp: new Date(),
        read: false
      };

      notifyRole(role, notificationData);
      return notificationData;
    } catch (error) {
      console.error('Error sending notification to role:', error);
      throw error;
    }
  }

  /**
   * Notify about new lead assignment
   */
  async notifyLeadAssignment(lead, assignedAgentId, assignedBy) {
    try {
      await this.sendToUser(assignedAgentId, {
        type: 'lead_assigned',
        title: 'New Lead Assigned',
        message: `You have been assigned a new lead: ${lead.contact.firstName} ${lead.contact.lastName}`,
        data: {
          leadId: lead._id,
          leadIdFormatted: lead.leadId,
          leadName: `${lead.contact.firstName} ${lead.contact.lastName}`,
          assignedBy: assignedBy
        },
        logActivity: true,
        senderId: assignedBy
      });
    } catch (error) {
      console.error('Error notifying lead assignment:', error);
    }
  }

  /**
   * Notify about lead status change
   */
  async notifyLeadStatusChange(lead, oldStatus, newStatus, changedBy) {
    try {
      // Notify assigned agent
      if (lead.assignedAgent) {
        await this.sendToUser(lead.assignedAgent, {
          type: 'lead_status_changed',
          title: 'Lead Status Updated',
          message: `Lead ${lead.leadId} status changed from ${oldStatus} to ${newStatus}`,
          data: {
            leadId: lead._id,
            leadIdFormatted: lead.leadId,
            oldStatus: oldStatus,
            newStatus: newStatus
          },
          logActivity: true,
          senderId: changedBy
        });
      }

      // Notify agency admin
      if (lead.agency) {
        await this.sendToAgency(lead.agency, {
          type: 'lead_status_changed',
          title: 'Lead Status Updated',
          message: `Lead ${lead.leadId} status changed to ${newStatus}`,
          data: {
            leadId: lead._id,
            leadIdFormatted: lead.leadId,
            newStatus: newStatus
          }
        });
      }
    } catch (error) {
      console.error('Error notifying lead status change:', error);
    }
  }

  /**
   * Notify about property approval/rejection
   */
  async notifyPropertyApproval(property, status, reason, reviewedBy) {
    try {
      if (property.agent) {
        await this.sendToUser(property.agent, {
          type: status === 'approved' ? 'property_approved' : 'property_rejected',
          title: status === 'approved' ? 'Property Approved' : 'Property Rejected',
          message: status === 'approved'
            ? `Your property "${property.title}" has been approved`
            : `Your property "${property.title}" has been rejected. Reason: ${reason || 'Not specified'}`,
          data: {
            propertyId: property._id,
            propertyTitle: property.title,
            status: status,
            reason: reason
          },
          logActivity: true,
          senderId: reviewedBy
        });
      }
    } catch (error) {
      console.error('Error notifying property approval:', error);
    }
  }

  /**
   * Notify about new task assignment
   */
  async notifyTaskAssignment(task, assignedTo, assignedBy) {
    try {
      await this.sendToUser(assignedTo, {
        type: 'task_assigned',
        title: 'New Task Assigned',
        message: `You have been assigned a new task: ${task.title}`,
        data: {
          taskId: task._id,
          taskTitle: task.title,
          dueDate: task.dueDate,
          assignedBy: assignedBy
        },
        logActivity: true,
        senderId: assignedBy
      });
    } catch (error) {
      console.error('Error notifying task assignment:', error);
    }
  }

  /**
   * Notify about upcoming follow-up
   */
  async notifyFollowUpReminder(lead, followUpDate) {
    try {
      if (lead.assignedAgent) {
        await this.sendToUser(lead.assignedAgent, {
          type: 'follow_up_reminder',
          title: 'Follow-up Reminder',
          message: `Follow-up reminder for lead ${lead.leadId}: ${lead.contact.firstName} ${lead.contact.lastName}`,
          data: {
            leadId: lead._id,
            leadIdFormatted: lead.leadId,
            followUpDate: followUpDate
          }
        });
      }
    } catch (error) {
      console.error('Error notifying follow-up reminder:', error);
    }
  }

  /**
   * Notify about site visit reminder
   */
  async notifySiteVisitReminder(lead, visitDate) {
    try {
      if (lead.siteVisit?.relationshipManager) {
        await this.sendToUser(lead.siteVisit.relationshipManager, {
          type: 'site_visit_reminder',
          title: 'Site Visit Reminder',
          message: `Site visit reminder for lead ${lead.leadId} scheduled for ${visitDate}`,
          data: {
            leadId: lead._id,
            leadIdFormatted: lead.leadId,
            visitDate: visitDate
          }
        });
      }
    } catch (error) {
      console.error('Error notifying site visit reminder:', error);
    }
  }

  /**
   * Notify about payment received
   */
  async notifyPaymentReceived(payment, recipientId) {
    try {
      await this.sendToUser(recipientId, {
        type: 'payment_received',
        title: 'Payment Received',
        message: `Payment of ${payment.currency} ${payment.amount} has been received`,
        data: {
          paymentId: payment._id,
          amount: payment.amount,
          currency: payment.currency,
          transactionId: payment.transaction
        }
      });
    } catch (error) {
      console.error('Error notifying payment received:', error);
    }
  }

  /**
   * Notify about property confirmation by customer
   */
  async notifyPropertyConfirmation(transaction) {
    try {
      const customerName = transaction.lead?.contact
        ? `${transaction.lead.contact.firstName} ${transaction.lead.contact.lastName}`
        : 'A customer';

      const propertyTitle = transaction.property?.title || 'a property';

      const notification = {
        type: 'property_confirmed',
        title: 'Property Booking Confirmed',
        message: `${customerName} has confirmed the booking for "${propertyTitle}".`,
        data: {
          transactionId: transaction._id,
          propertyId: transaction.property?._id,
          leadId: transaction.lead?._id,
          amount: transaction.amount
        },
        logActivity: true
      };

      // 1. Notify Assigned Agent
      if (transaction.agent) {
        await this.sendToUser(transaction.agent, notification);
      }

      // 2. Notify Agency Admins
      if (transaction.agency) {
        await this.sendToAgency(transaction.agency, notification);
      }

      // 3. Notify Super Admins
      await this.sendToRole('super_admin', notification);

    } catch (error) {
      console.error('Error notifying property confirmation:', error);
    }
  }
}

module.exports = new NotificationService();

