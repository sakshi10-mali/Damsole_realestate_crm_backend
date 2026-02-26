const User = require('../models/User');
const Lead = require('../models/Lead');
const Property = require('../models/Property');

class LeadAssignmentService {
  /**
   * Auto-assign lead using round-robin method
   */
  async roundRobinAssignment(agencyId) {
    try {
      const agents = await User.find({
        role: 'agent',
        agency: agencyId,
        isActive: true
      }).sort({ createdAt: 1 });

      if (agents.length === 0) {
        return null;
      }

      // Get the last assigned agent for this agency
      const lastAssignedLead = await Lead.findOne({
        agency: agencyId,
        assignedAgent: { $exists: true, $ne: null }
      })
        .sort({ createdAt: -1 })
        .select('assignedAgent');

      if (!lastAssignedLead || !lastAssignedLead.assignedAgent) {
        // First assignment - assign to first agent
        return agents[0]._id;
      }

      // Find the index of last assigned agent
      const lastAgentIndex = agents.findIndex(
        agent => agent._id.toString() === lastAssignedLead.assignedAgent.toString()
      );

      // Assign to next agent in round-robin
      const nextIndex = (lastAgentIndex + 1) % agents.length;
      return agents[nextIndex]._id;
    } catch (error) {
      console.error('Round-robin assignment error:', error);
      return null;
    }
  }

  /**
   * Auto-assign lead based on agent workload (least leads assigned)
   */
  async workloadBasedAssignment(agencyId) {
    try {
      const agents = await User.find({
        role: 'agent',
        agency: agencyId,
        isActive: true
      });

      if (agents.length === 0) {
        return null;
      }

      // Get lead counts for each agent
      const agentWorkloads = await Promise.all(
        agents.map(async (agent) => {
          const leadCount = await Lead.countDocuments({
            agency: agencyId,
            assignedAgent: agent._id,
            status: { $in: ['new', 'contacted', 'site_visit', 'negotiation'] }
          });

          return {
            agentId: agent._id,
            workload: leadCount,
            agent
          };
        })
      );

      // Sort by workload (ascending) and return agent with least workload
      agentWorkloads.sort((a, b) => a.workload - b.workload);
      return agentWorkloads[0].agentId;
    } catch (error) {
      console.error('Workload-based assignment error:', error);
      return null;
    }
  }

  /**
   * Auto-assign lead based on location
   */
  async locationBasedAssignment(agencyId, preferredLocation) {
    try {
      if (!preferredLocation || preferredLocation.length === 0) {
        return null;
      }

      // Find agents with matching location preferences or expertise
      const agents = await User.find({
        role: 'agent',
        agency: agencyId,
        isActive: true
      });

      if (agents.length === 0) {
        return null;
      }

      // Try to find agents with matching location in their profile
      // This assumes agent profile has location/expertise fields
      const matchingAgents = agents.filter(agent => {
        if (agent.agentInfo?.locations) {
          return agent.agentInfo.locations.some(loc => 
            preferredLocation.some(pref => 
              loc.toLowerCase().includes(pref.toLowerCase()) || 
              pref.toLowerCase().includes(loc.toLowerCase())
            )
          );
        }
        return false;
      });

      if (matchingAgents.length > 0) {
        // Return agent with least workload from matching agents
        const workloads = await Promise.all(
          matchingAgents.map(async (agent) => {
            const leadCount = await Lead.countDocuments({
              agency: agencyId,
              assignedAgent: agent._id,
              status: { $in: ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation'] }
            });
            return { agentId: agent._id, workload: leadCount };
          })
        );
        workloads.sort((a, b) => a.workload - b.workload);
        return workloads[0].agentId;
      }

      return null;
    } catch (error) {
      console.error('Location-based assignment error:', error);
      return null;
    }
  }

  /**
   * Auto-assign lead based on project/property
   */
  async projectBasedAssignment(agencyId, propertyId) {
    try {
      if (!propertyId) {
        return null;
      }

      // Find property and check if it has assigned agents
      const property = await Property.findById(propertyId)
        .populate('assignedAgents');

      if (property && property.assignedAgents && property.assignedAgents.length > 0) {
        // Get active agents from assigned agents
        const activeAssignedAgents = property.assignedAgents.filter(
          agent => agent.isActive && agent.agency?.toString() === agencyId.toString()
        );

        if (activeAssignedAgents.length > 0) {
          // Return agent with least workload
          const workloads = await Promise.all(
            activeAssignedAgents.map(async (agent) => {
              const leadCount = await Lead.countDocuments({
                agency: agencyId,
                assignedAgent: agent._id,
                status: { $in: ['new', 'contacted', 'qualified', 'site_visit_scheduled', 'site_visit_completed', 'negotiation'] }
              });
              return { agentId: agent._id, workload: leadCount };
            })
          );
          workloads.sort((a, b) => a.workload - b.workload);
          return workloads[0].agentId;
        }
      }

      return null;
    } catch (error) {
      console.error('Project-based assignment error:', error);
      return null;
    }
  }

  /**
   * Auto-assign lead based on source
   */
  async sourceBasedAssignment(agencyId, source) {
    try {
      // This can be customized based on source-specific assignment rules
      // For example, assign referral leads to specific agents
      // For now, fall back to workload-based
      return await this.workloadBasedAssignment(agencyId);
    } catch (error) {
      console.error('Source-based assignment error:', error);
      return null;
    }
  }

  /**
   * Smart assignment with multiple rules
   */
  async smartAssignment(agencyId, leadData) {
    try {
      // Priority order: Project > Location > Source > Workload > Round-robin
      
      // 1. Try project-based assignment
      if (leadData.property) {
        const agentId = await this.projectBasedAssignment(agencyId, leadData.property);
        if (agentId) return agentId;
      }

      // 2. Try location-based assignment
      if (leadData.inquiry?.preferredLocation && leadData.inquiry.preferredLocation.length > 0) {
        const agentId = await this.locationBasedAssignment(agencyId, leadData.inquiry.preferredLocation);
        if (agentId) return agentId;
      }

      // 3. Try source-based assignment
      if (leadData.source) {
        const agentId = await this.sourceBasedAssignment(agencyId, leadData.source);
        if (agentId) return agentId;
      }

      // 4. Fall back to workload-based
      return await this.workloadBasedAssignment(agencyId);
    } catch (error) {
      console.error('Smart assignment error:', error);
      return null;
    }
  }

  /**
   * Auto-assign lead based on agency settings
   */
  async autoAssignLead(agencyId, assignmentMethod = 'round_robin', leadData = {}) {
    try {
      if (assignmentMethod === 'smart') {
        return await this.smartAssignment(agencyId, leadData);
      } else if (assignmentMethod === 'workload') {
        return await this.workloadBasedAssignment(agencyId);
      } else if (assignmentMethod === 'location' && leadData.inquiry?.preferredLocation) {
        return await this.locationBasedAssignment(agencyId, leadData.inquiry.preferredLocation);
      } else if (assignmentMethod === 'project' && leadData.property) {
        return await this.projectBasedAssignment(agencyId, leadData.property);
      } else {
        // Default to round-robin
        return await this.roundRobinAssignment(agencyId);
      }
    } catch (error) {
      console.error('Auto-assign lead error:', error);
      return null;
    }
  }
}

module.exports = new LeadAssignmentService();

