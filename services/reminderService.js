const Lead = require('../models/Lead');
const emailService = require('./emailService');
const smsService = require('./smsService');
const User = require('../models/User');
const Agency = require('../models/Agency');
const encryptionService = require('./encryptionService');

class ReminderService {
  async checkFollowUpReminders() {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Find leads with follow-up dates today or tomorrow
      const leads = await Lead.find({
        followUpDate: {
          $gte: now,
          $lte: tomorrow
        },
        status: { $in: ['new', 'contacted', 'site_visit', 'negotiation'] }
      })
        .populate('assignedAgent', 'firstName lastName email phone')
        .populate('agency', 'name settings');

      const reminders = [];
      
      for (const lead of leads) {
        if (lead.assignedAgent) {
          const agent = lead.assignedAgent;
          const agency = lead.agency;
          
          // Decrypt contact information if encryption is enabled
          const leadObj = lead.toObject();
          if (leadObj.contact) {
            leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
          }
          const leadForEmail = { ...lead, contact: leadObj.contact };
          
          // Send email reminder
          try {
            await emailService.sendFollowUpReminder(leadForEmail, agent, agency);
            reminders.push({
              lead: lead._id,
              agent: agent._id,
              type: 'email',
              sent: true
            });
          } catch (error) {
            console.error(`Error sending email reminder for lead ${lead._id}:`, error);
            reminders.push({
              lead: lead._id,
              agent: agent._id,
              type: 'email',
              sent: false,
              error: error.message
            });
          }

          // Send SMS reminder if enabled
          if (agency?.settings?.smsNotifications && agent.phone) {
            try {
              await smsService.sendFollowUpReminder(leadForEmail, agent);
              reminders.push({
                lead: lead._id,
                agent: agent._id,
                type: 'sms',
                sent: true
              });
            } catch (error) {
              console.error(`Error sending SMS reminder for lead ${lead._id}:`, error);
            }
          }
        }
      }

      return {
        checked: leads.length,
        remindersSent: reminders.filter(r => r.sent).length,
        reminders
      };
    } catch (error) {
      console.error('Error checking follow-up reminders:', error);
      throw error;
    }
  }

  async checkTaskReminders() {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Find leads with tasks due today or tomorrow
      const leads = await Lead.find({
        'tasks.status': { $in: ['pending', 'in_progress'] },
        'tasks.dueDate': {
          $gte: now,
          $lte: tomorrow
        }
      })
        .populate('assignedAgent', 'firstName lastName email phone')
        .populate('agency', 'name settings');

      const reminders = [];
      
      for (const lead of leads) {
        const dueTasks = lead.tasks.filter(task => {
          const dueDate = new Date(task.dueDate);
          return dueDate >= now && dueDate <= tomorrow && 
                 ['pending', 'in_progress'].includes(task.status);
        });

        if (dueTasks.length > 0 && lead.assignedAgent) {
          const agent = lead.assignedAgent;
          const agency = lead.agency;
          
          // Decrypt contact information if encryption is enabled
          const leadObj = lead.toObject();
          if (leadObj.contact) {
            leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
          }
          const leadForEmail = { ...lead, contact: leadObj.contact };
          
          try {
            await emailService.sendTaskReminder(leadForEmail, agent, agency, dueTasks);
            reminders.push({
              lead: lead._id,
              agent: agent._id,
              tasksCount: dueTasks.length,
              sent: true
            });
          } catch (error) {
            console.error(`Error sending task reminder for lead ${lead._id}:`, error);
          }
        }
      }

      return {
        checked: leads.length,
        remindersSent: reminders.filter(r => r.sent).length,
        reminders
      };
    } catch (error) {
      console.error('Error checking task reminders:', error);
      throw error;
    }
  }

  async checkRecurringFollowUps() {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Find leads with recurring follow-ups enabled and next follow-up date approaching
      const leads = await Lead.find({
        'recurringFollowUp.enabled': true,
        'recurringFollowUp.nextFollowUpDate': {
          $gte: now,
          $lte: tomorrow
        },
        status: { $nin: ['lost', 'closed', 'booked', 'junk'] }
      })
        .populate('assignedAgent', 'firstName lastName email phone')
        .populate('agency', 'name settings');

      const reminders = [];
      
      for (const lead of leads) {
        if (lead.assignedAgent) {
          const agent = lead.assignedAgent;
          const agency = lead.agency;
          
          // Decrypt contact information if encryption is enabled
          const leadObj = lead.toObject();
          if (leadObj.contact) {
            leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
          }
          const leadForEmail = { ...lead, contact: leadObj.contact };
          
          // Send email reminder
          try {
            await emailService.sendFollowUpReminder(leadForEmail, agent, agency);
            reminders.push({
              lead: lead._id,
              agent: agent._id,
              type: 'email',
              sent: true
            });
          } catch (error) {
            console.error(`Error sending recurring follow-up reminder for lead ${lead._id}:`, error);
          }

          // Send SMS reminder if enabled
          if (agency?.settings?.smsNotifications && agent.phone) {
            try {
              await smsService.sendFollowUpReminder(leadForEmail, agent);
              reminders.push({
                lead: lead._id,
                agent: agent._id,
                type: 'sms',
                sent: true
              });
            } catch (error) {
              console.error(`Error sending SMS recurring follow-up reminder for lead ${lead._id}:`, error);
            }
          }

          // Schedule next recurring follow-up
          const nextDate = new Date(lead.recurringFollowUp.nextFollowUpDate);
          nextDate.setDate(nextDate.getDate() + lead.recurringFollowUp.interval);
          
          lead.recurringFollowUp.nextFollowUpDate = nextDate;
          lead.recurringFollowUp.count = (lead.recurringFollowUp.count || 0) + 1;
          lead.followUpDate = nextDate;
          
          await lead.save();
        }
      }

      return {
        checked: leads.length,
        remindersSent: reminders.filter(r => r.sent).length,
        reminders
      };
    } catch (error) {
      console.error('Error checking recurring follow-ups:', error);
      throw error;
    }
  }

  async checkSiteVisitReminders() {
    try {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      // Find leads with site visits scheduled in the next 24 hours
      const leads = await Lead.find({
        'siteVisit.status': 'scheduled',
        'siteVisit.scheduledDate': {
          $gte: now,
          $lte: tomorrow
        }
      })
        .populate('siteVisit.relationshipManager', 'firstName lastName email phone')
        .populate('assignedAgent', 'firstName lastName email phone')
        .populate('agency', 'name settings')
        .populate('property', 'title');

      const reminders = [];
      
      for (const lead of leads) {
        const rm = lead.siteVisit?.relationshipManager || lead.assignedAgent;
        const agency = lead.agency;
        
        if (rm) {
          // Decrypt contact information if encryption is enabled
          const leadObj = lead.toObject();
          if (leadObj.contact) {
            leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
          }
          const leadForEmail = { ...lead, contact: leadObj.contact };
          
          // Send reminder to relationship manager/agent
          try {
            const visitDate = new Date(lead.siteVisit.scheduledDate).toLocaleDateString();
            const visitTime = lead.siteVisit.scheduledTime || 'TBD';
            const propertyName = lead.property?.title || 'Property';
            
            const message = `Reminder: Site visit scheduled for ${leadObj.contact.firstName} ${leadObj.contact.lastName} on ${visitDate} at ${visitTime}. Property: ${propertyName}.`;
            
            if (rm.email) {
              await emailService.sendSiteVisitReminder(leadForEmail, rm, agency);
            }
            
            if (agency?.settings?.smsNotifications && rm.phone) {
              await smsService.sendSMS(rm.phone, message);
            }
            
            reminders.push({
              lead: lead._id,
              agent: rm._id,
              type: 'site_visit_reminder',
              sent: true
            });
          } catch (error) {
            console.error(`Error sending site visit reminder for lead ${lead._id}:`, error);
          }
        }
      }

      return {
        checked: leads.length,
        remindersSent: reminders.filter(r => r.sent).length,
        reminders
      };
    } catch (error) {
      console.error('Error checking site visit reminders:', error);
      throw error;
    }
  }

  /**
   * Check for missed follow-ups (past due)
   */
  async checkMissedFollowUps() {
    try {
      const now = new Date();
      
      // Find leads with follow-up dates in the past (missed)
      // Only check leads that are still active (not lost/closed/booked/junk)
      const leads = await Lead.find({
        followUpDate: {
          $lt: now // Past due
        },
        status: { $in: ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation'] }
      })
        .populate('assignedAgent', 'firstName lastName email phone')
        .populate('agency', 'name settings')
        .populate('reportingManager', 'firstName lastName email');

      const alerts = [];
      
      for (const lead of leads) {
        if (lead.assignedAgent) {
          const agent = lead.assignedAgent;
          const agency = lead.agency;
          const reportingManager = lead.reportingManager;
          
          // Decrypt contact information if encryption is enabled
          const leadObj = lead.toObject();
          if (leadObj.contact) {
            leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
          }
          
          // Calculate days overdue
          const daysOverdue = Math.floor((now - new Date(lead.followUpDate)) / (1000 * 60 * 60 * 24));
          
          // Create lead object with decrypted contact for email service
          const leadForEmail = { ...lead, contact: leadObj.contact };
          
          // Send alert to assigned agent
          try {
            // Send email alert
            await emailService.sendMissedFollowUpAlert(leadForEmail, agent, agency, daysOverdue);
            
            alerts.push({
              lead: lead._id,
              leadId: lead.leadId,
              agent: agent._id,
              type: 'email',
              daysOverdue: daysOverdue,
              sent: true
            });
          } catch (error) {
            console.error(`Error sending missed follow-up email alert for lead ${lead._id}:`, error);
            alerts.push({
              lead: lead._id,
              agent: agent._id,
              type: 'email',
              sent: false,
              error: error.message
            });
          }

          // Send SMS alert if enabled
          if (agency?.settings?.smsNotifications && agent.phone) {
            try {
              const smsMessage = `⚠️ MISSED FOLLOW-UP: Lead ${lead.leadId} (${leadObj.contact.firstName} ${leadObj.contact.lastName}) is ${daysOverdue} day(s) overdue. Please follow up immediately.`;
              await smsService.sendSMS(agent.phone, smsMessage);
              
              alerts.push({
                lead: lead._id,
                agent: agent._id,
                type: 'sms',
                daysOverdue: daysOverdue,
                sent: true
              });
            } catch (error) {
              console.error(`Error sending missed follow-up SMS alert for lead ${lead._id}:`, error);
            }
          }

          // Also notify reporting manager if different from agent
          if (reportingManager && reportingManager._id.toString() !== agent._id.toString()) {
            try {
              await emailService.sendMissedFollowUpAlertToManager(leadForEmail, agent, reportingManager, agency, daysOverdue);
              
              alerts.push({
                lead: lead._id,
                manager: reportingManager._id,
                type: 'manager_alert',
                daysOverdue: daysOverdue,
                sent: true
              });
            } catch (error) {
              console.error(`Error sending missed follow-up alert to manager for lead ${lead._id}:`, error);
            }
          }
        }
      }

      return {
        checked: leads.length,
        alertsSent: alerts.filter(a => a.sent).length,
        alerts: alerts
      };
    } catch (error) {
      console.error('Error checking missed follow-ups:', error);
      throw error;
    }
  }

  /**
   * Check for missed tasks (past due)
   */
  async checkMissedTasks() {
    try {
      const now = new Date();
      
      // Find leads with tasks that are past due
      const leads = await Lead.find({
        'tasks.status': { $in: ['pending', 'in_progress'] },
        'tasks.dueDate': {
          $lt: now // Past due
        }
      })
        .populate('assignedAgent', 'firstName lastName email phone')
        .populate('agency', 'name settings')
        .populate('tasks.assignedTo', 'firstName lastName email phone');

      const alerts = [];
      
      for (const lead of leads) {
        const missedTasks = lead.tasks.filter(task => {
          const dueDate = new Date(task.dueDate);
          return dueDate < now && ['pending', 'in_progress'].includes(task.status);
        });

        if (missedTasks.length > 0) {
          const taskAssignee = missedTasks[0].assignedTo || lead.assignedAgent;
          const agency = lead.agency;
          
          if (taskAssignee) {
            // Decrypt contact information if encryption is enabled
            const leadObj = lead.toObject();
            if (leadObj.contact) {
              leadObj.contact = encryptionService.decryptLeadContact(leadObj.contact);
            }
            const leadForEmail = { ...lead, contact: leadObj.contact };
            
            try {
              const daysOverdue = Math.floor((now - new Date(missedTasks[0].dueDate)) / (1000 * 60 * 60 * 24));
              
              await emailService.sendMissedTaskAlert(leadForEmail, taskAssignee, agency, missedTasks, daysOverdue);
              
              alerts.push({
                lead: lead._id,
                agent: taskAssignee._id,
                tasksCount: missedTasks.length,
                daysOverdue: daysOverdue,
                sent: true
              });
            } catch (error) {
              console.error(`Error sending missed task alert for lead ${lead._id}:`, error);
            }
          }
        }
      }

      return {
        checked: leads.length,
        alertsSent: alerts.filter(a => a.sent).length,
        alerts: alerts
      };
    } catch (error) {
      console.error('Error checking missed tasks:', error);
      throw error;
    }
  }
}

module.exports = new ReminderService();

