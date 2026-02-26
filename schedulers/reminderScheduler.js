const reminderService = require('../services/reminderService');

class ReminderScheduler {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) {
      console.log('Reminder scheduler is already running');
      return;
    }

    console.log('Starting reminder scheduler...');
    this.isRunning = true;

    // Run immediately on start
    this.runReminders();

    // Run every hour
    this.intervalId = setInterval(() => {
      this.runReminders();
    }, 60 * 60 * 1000); // 1 hour
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('Reminder scheduler stopped');
  }

  async runReminders() {
    try {
      console.log('Running reminder checks...');
      
      // Check follow-up reminders
      const followUpResult = await reminderService.checkFollowUpReminders();
      console.log(`Follow-up reminders: ${followUpResult.remindersSent} sent out of ${followUpResult.checked} checked`);

      // Check recurring follow-ups
      const recurringResult = await reminderService.checkRecurringFollowUps();
      console.log(`Recurring follow-ups: ${recurringResult.remindersSent} sent out of ${recurringResult.checked} checked`);

      // Check site visit reminders
      const siteVisitResult = await reminderService.checkSiteVisitReminders();
      console.log(`Site visit reminders: ${siteVisitResult.remindersSent} sent out of ${siteVisitResult.checked} checked`);

      // Check task reminders
      const taskResult = await reminderService.checkTaskReminders();
      console.log(`Task reminders: ${taskResult.remindersSent} sent out of ${taskResult.checked} checked`);

      // Check missed follow-ups
      const missedFollowUpResult = await reminderService.checkMissedFollowUps();
      console.log(`Missed follow-up alerts: ${missedFollowUpResult.alertsSent} sent out of ${missedFollowUpResult.checked} checked`);

      // Check missed tasks
      const missedTaskResult = await reminderService.checkMissedTasks();
      console.log(`Missed task alerts: ${missedTaskResult.alertsSent} sent out of ${missedTaskResult.checked} checked`);
    } catch (error) {
      console.error('Error running reminders:', error);
    }
  }
}

// Create singleton instance
const reminderScheduler = new ReminderScheduler();

// Start scheduler when module is loaded (only in production or when explicitly enabled)
if (process.env.ENABLE_REMINDER_SCHEDULER === 'true' || process.env.NODE_ENV === 'production') {
  reminderScheduler.start();
}

module.exports = reminderScheduler;

