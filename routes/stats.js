const express = require('express');
const mongoose = require('mongoose');
const Property = require('../models/Property');
const Lead = require('../models/Lead');
const User = require('../models/User');
const Agency = require('../models/Agency');
const Transaction = require('../models/Transaction');
const { auth, authorize, checkModulePermission } = require('../middleware/auth');

const router = express.Router();

// @route   GET /api/stats/dashboard
// @desc    Get optimized dashboard statistics
// @access  Private
router.get('/dashboard', auth, checkModulePermission('leads', 'view'), async (req, res) => {
  try {
    const leadFilter = {};
    const propertyFilter = {};
    const transactionFilter = {};

    // Role-based filtering with explicit ObjectId casting for aggregation
    const agencyId = req.user.agency && mongoose.Types.ObjectId.isValid(req.user.agency)
      ? new mongoose.Types.ObjectId(req.user.agency)
      : req.user.agency;

    const userId = req.user.id && mongoose.Types.ObjectId.isValid(req.user.id)
      ? new mongoose.Types.ObjectId(req.user.id)
      : req.user.id;

    if (req.user.role === 'agency_admin') {
      leadFilter.agency = agencyId;
      propertyFilter.agency = agencyId;
      transactionFilter.agency = agencyId;
    } else if (req.user.role === 'agent') {
      // Agents see leads assigned to them OR leads for properties they manage
      const agentProperties = await Property.find({ agent: userId }).distinct('_id');

      leadFilter.agency = agencyId;
      leadFilter.$and = [
        {
          $or: [
            { assignedAgent: userId },
            { property: { $in: agentProperties } }
          ]
        }
      ];

      propertyFilter.agent = userId;
      propertyFilter.agency = agencyId;
      transactionFilter.agent = userId;
    }

    // Use aggregation for efficient counting
    const [
      totalAgencies,
      totalProperties,
      activeProperties,
      totalLeads,
      activeLeads,
      agentStats,
      staffStats,
      inquiryStats,
      inquiriesByAgency,
      transactionStats,
      newAgencies,
      newProperties,
      newLeads,
      newUsers
    ] = await Promise.all([
      // Total agencies (only for super_admin and staff)
      (req.user.role === 'super_admin' || req.user.role === 'staff')
        ? Agency.countDocuments()
        : Promise.resolve(0),

      // Total properties
      Property.countDocuments(propertyFilter),

      // Active properties
      Property.countDocuments({ ...propertyFilter, status: 'active' }),

      // Total leads
      Lead.countDocuments(leadFilter),

      // Active leads
      Lead.countDocuments({
        ...leadFilter,
        status: { $in: ['new', 'contacted', 'site_visit_scheduled', 'site_visit_completed', 'negotiation'] }
      }),

      // Agent Stats
      User.aggregate([
        {
          $match: {
            role: 'agent',
            ...((req.user.role !== 'super_admin' && req.user.role !== 'staff') ? { agency: agencyId } : {})
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ['$isActive', 1, 0] } }
          }
        }
      ]),

      // Staff Stats
      User.aggregate([
        {
          $match: {
            role: 'staff',
            ...((req.user.role !== 'super_admin' && req.user.role !== 'staff') ? { agency: agencyId } : {})
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: { $sum: { $cond: ['$isActive', 1, 0] } }
          }
        }
      ]),

      // Inquiry stats by source (aggregation)
      Lead.aggregate([
        { $match: leadFilter },
        {
          $group: {
            _id: '$source',
            count: { $sum: 1 }
          }
        }
      ]),

      // Inquiries by agency (only for super_admin and staff)
      (req.user.role === 'super_admin' || req.user.role === 'staff')
        ? Lead.aggregate([
          {
            $group: {
              _id: '$agency',
              count: { $sum: 1 }
            }
          },
          {
            $lookup: {
              from: 'agencies',
              localField: '_id',
              foreignField: '_id',
              as: 'agency'
            }
          },
          {
            $unwind: {
              path: '$agency',
              preserveNullAndEmptyArrays: true
            }
          },
          {
            $project: {
              name: { $ifNull: ['$agency.name', 'Unknown Agency'] },
              count: 1
            }
          },
          { $limit: 10 }
        ])
        : Promise.resolve([]),

      // Transaction Stats
      Transaction.aggregate([
        { $match: transactionFilter },
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            completedTransactions: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            totalRevenue: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount', 0] } },
            totalCommission: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, { $ifNull: ['$commission.amount', 0] }, 0] } }
          }
        }
      ]),

      // New Today (Last 24h)
      Agency.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      Property.countDocuments({ ...propertyFilter, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      Lead.countDocuments({ ...leadFilter, createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      User.countDocuments({
        ...((req.user.role !== 'super_admin' && req.user.role !== 'staff') ? { agency: agencyId } : {}),
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      })
    ]);

    // Format inquiry stats
    const formattedInquiryStats = {
      website: 0,
      phone: 0,
      email: 0,
      walk_in: 0,
      referral: 0,
      other: 0
    };

    inquiryStats.forEach(stat => {
      const source = stat._id || 'other';
      if (formattedInquiryStats.hasOwnProperty(source)) {
        formattedInquiryStats[source] = stat.count;
      } else {
        formattedInquiryStats.other += stat.count;
      }
    });

    const agentRes = agentStats[0] || { total: 0, active: 0 };
    const staffRes = staffStats[0] || { total: 0, active: 0 };
    const transRes = transactionStats[0] || { totalTransactions: 0, completedTransactions: 0, totalRevenue: 0, totalCommission: 0 };

    // Property stats by status

    // Property stats by status
    const propertyStatusStats = await Property.aggregate([
      { $match: propertyFilter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const propertyStatusMap = {};
    propertyStatusStats.forEach(stat => {
      propertyStatusMap[stat._id] = stat.count;
    });

    // Unique locations aggregation
    const uniqueLocations = await Property.aggregate([
      { $match: propertyFilter },
      {
        $group: {
          _id: null,
          cities: { $addToSet: '$location.city' },
          states: { $addToSet: '$location.state' },
          countries: { $addToSet: '$location.country' },
          areas: { $addToSet: '$location.area' }
        }
      }
    ]);

    const locations = uniqueLocations[0] || { cities: [], states: [], countries: [], areas: [] };
    // Filter out null/empty values and sort
    const cleanSort = (arr) => [...new Set(arr.filter(Boolean))].sort();

    res.json({
      totalAgencies,
      totalProperties,
      activeProperties: propertyStatusMap['active'] || 0,
      soldProperties: propertyStatusMap['sold'] || 0,
      rentedProperties: propertyStatusMap['rented'] || 0,
      pendingProperties: propertyStatusMap['pending'] || 0,
      inactiveProperties: propertyStatusMap['inactive'] || 0,
      uniqueLocations: {
        cities: cleanSort(locations.cities),
        states: cleanSort(locations.states),
        countries: cleanSort(locations.countries),
        areas: cleanSort(locations.areas)
      },
      totalLeads,
      activeLeads,
      totalAgents: agentRes.total,
      activeAgents: agentRes.active,
      inactiveAgents: agentRes.total - agentRes.active,
      totalStaff: staffRes.total,
      activeStaff: staffRes.active,
      inactiveStaff: staffRes.total - staffRes.active,
      inquiryStats: formattedInquiryStats,
      inquiriesByAgency,
      transactions: transRes,
      newAgencies,
      newProperties,
      newLeads,
      newUsers
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/stats/reports
// @desc    Get optimized report statistics with date filtering
// @access  Private
router.get('/reports', auth, checkModulePermission('analytics', 'view'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const filter = {};
    const dateFilter = {};

    // Date filtering
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) {
        const [year, month, day] = startDate.split('-').map(Number);
        dateFilter.createdAt.$gte = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
      }
      if (endDate) {
        const [year, month, day] = endDate.split('-').map(Number);
        dateFilter.createdAt.$lte = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
      }
    }

    let leadFilter = { ...dateFilter };
    let propertyFilter = { ...dateFilter };

    const agencyIdForFilter = req.user.agency && mongoose.Types.ObjectId.isValid(req.user.agency)
      ? new mongoose.Types.ObjectId(req.user.agency)
      : req.user.agency;

    // Role-based filtering
    if (req.user.role === 'agency_admin') {
      leadFilter.agency = req.user.agency;
      propertyFilter.agency = req.user.agency;
    } else if (req.user.role === 'agent') {
      const agentId = mongoose.Types.ObjectId.isValid(req.user.id) ? new mongoose.Types.ObjectId(req.user.id) : req.user.id;
      const agentProperties = await Property.find({ agent: agentId }).distinct('_id');

      leadFilter.agency = req.user.agency;
      leadFilter.$and = leadFilter.$and || [];
      leadFilter.$and.push({
        $or: [
          { assignedAgent: agentId },
          { property: { $in: agentProperties } }
        ]
      });

      propertyFilter.agent = agentId;
      propertyFilter.agency = req.user.agency;
    }

    // Use aggregation for efficient statistics
    const [
      propertiesByStatus,
      propertiesByType,
      propertiesByListingType,
      propertiesByLocation,
      leadsByStatus,
      leadsBySource,
      leadsByPriority,
      usersByRole,
      totalPropertyValue,
      recentProperties,
      recentLeads,
      agentPerformance
    ] = await Promise.all([
      // Properties by status
      Property.aggregate([
        { $match: propertyFilter },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]),

      // Properties by type
      Property.aggregate([
        { $match: propertyFilter },
        {
          $group: {
            _id: '$propertyType',
            count: { $sum: 1 }
          }
        }
      ]),

      // Properties by listing type
      Property.aggregate([
        { $match: propertyFilter },
        {
          $group: {
            _id: '$listingType',
            count: { $sum: 1 }
          }
        }
      ]),

      // Properties by location
      Property.aggregate([
        { $match: propertyFilter },
        {
          $group: {
            _id: '$location.city',
            count: { $sum: 1 }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),

      // Leads by status
      Lead.aggregate([
        { $match: leadFilter },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]),

      // Leads by source
      Lead.aggregate([
        { $match: leadFilter },
        {
          $group: {
            _id: '$source',
            count: { $sum: 1 }
          }
        }
      ]),

      // Leads by priority
      Lead.aggregate([
        { $match: leadFilter },
        {
          $group: {
            _id: '$priority',
            count: { $sum: 1 }
          }
        }
      ]),

      // Users by role (only for super_admin)
      req.user.role === 'super_admin'
        ? User.aggregate([
          { $match: dateFilter },
          {
            $group: {
              _id: '$role',
              count: { $sum: 1 }
            }
          }
        ])
        : Promise.resolve([]),

      // Total property value (sale prices only)
      Property.aggregate([
        { $match: propertyFilter },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: [
                  { $ifNull: ['$price.sale', false] },
                  '$price.sale',
                  0
                ]
              }
            }
          }
        }
      ]),

      // Recent Activity - Properties
      Property.find(propertyFilter)
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('agent', 'firstName lastName')
        .lean(),

      // Recent Activity - Leads
      Lead.find(leadFilter)
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),

      // Agent Performance
      User.aggregate([
        {
          $match: {
            role: 'agent',
            ...(req.user.role !== 'super_admin' && agencyIdForFilter ? { agency: agencyIdForFilter } : {})
          }
        },
        {
          $lookup: {
            from: 'leads',
            localField: '_id',
            foreignField: 'assignedAgent',
            as: 'leads'
          }
        },
        {
          $lookup: {
            from: 'properties',
            localField: '_id',
            foreignField: 'agent',
            as: 'properties'
          }
        },
        {
          $project: {
            firstName: 1,
            lastName: 1,
            email: 1,
            totalLeads: { $size: '$leads' },
            convertedLeads: {
              $size: {
                $filter: {
                  input: '$leads',
                  as: 'lead',
                  cond: { $eq: ['$$lead.status', 'converted'] }
                }
              }
            },
            totalProperties: { $size: '$properties' },
            activeProperties: {
              $size: {
                $filter: {
                  input: '$properties',
                  as: 'prop',
                  cond: { $eq: ['$$prop.status', 'active'] }
                }
              }
            }
          }
        },
        { $sort: { totalLeads: -1 } },
        { $limit: 10 }
      ])
    ]);

    // Format results
    const formatStats = (stats) => {
      const result = {};
      stats.forEach(stat => {
        result[stat._id || 'unknown'] = stat.count;
      });
      return result;
    };

    // Format recent activity
    const recentActivity = [
      ...recentProperties.map(p => ({
        type: 'property_added',
        message: `New property: ${p.title}`,
        time: p.createdAt,
        user: p.agent ? `${p.agent.firstName || ''} ${p.agent.lastName || ''}`.trim() : 'System',
        link: `/admin/properties/${p._id}`
      })),
      ...recentLeads.map(l => ({
        type: 'lead_created',
        message: `New lead: ${l.contact?.firstName || ''} ${l.contact?.lastName || ''}`.trim(),
        time: l.createdAt,
        user: l.source || 'Website',
        link: `/admin/leads/${l._id}`
      }))
    ].sort((a, b) => new Date(b.time) - new Date(a.time));

    // Agency analysis (super_admin and agency_admin only)
    let agencyAnalysis = [];
    if (req.user.role === 'super_admin' || req.user.role === 'agency_admin') {
      const agencyFilterForList = req.user.role === 'agency_admin' && agencyIdForFilter
        ? { _id: agencyIdForFilter }
        : {};
      const [agencies, agentsByAgency, propertiesByAgency, leadsByAgency] = await Promise.all([
        Agency.find(agencyFilterForList).lean(),
        User.aggregate([
          { $match: { role: 'agent', ...(agencyFilterForList._id ? { agency: agencyFilterForList._id } : {}) } },
          { $group: { _id: '$agency', totalAgents: { $sum: 1 }, activeAgents: { $sum: { $cond: ['$isActive', 1, 0] } } } }
        ]),
        Property.aggregate([
          { $match: agencyFilterForList._id ? { agency: agencyFilterForList._id } : {} },
          { $group: { _id: '$agency', totalProperties: { $sum: 1 }, activeProperties: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }, totalPropertyValue: { $sum: { $ifNull: ['$price.sale', 0] } } } }
        ]),
        Lead.aggregate([
          { $match: agencyFilterForList._id ? { agency: agencyFilterForList._id } : {} },
          { $group: { _id: '$agency', totalLeads: { $sum: 1 }, convertedLeads: { $sum: { $cond: [{ $in: ['$status', ['booked', 'closed']] }, 1, 0] } } } }
        ])
      ]);
      const agentsMap = Object.fromEntries((agentsByAgency || []).map(x => [x._id?.toString(), x]));
      const propsMap = Object.fromEntries((propertiesByAgency || []).map(x => [x._id?.toString(), x]));
      const leadsMap = Object.fromEntries((leadsByAgency || []).map(x => [x._id?.toString(), x]));
      agencyAnalysis = (agencies || []).map(agency => {
        const id = agency._id?.toString();
        const agents = agentsMap[id] || { totalAgents: 0, activeAgents: 0 };
        const props = propsMap[id] || { totalProperties: 0, activeProperties: 0, totalPropertyValue: 0 };
        const leads = leadsMap[id] || { totalLeads: 0, convertedLeads: 0 };
        const totalAgents = agents.totalAgents || 0;
        const totalLeads = leads.totalLeads || 0;
        const hasNoAgents = totalAgents === 0;
        const hasNoLeads = totalLeads === 0;
        let healthStatus = 'good';
        if (hasNoAgents || hasNoLeads) healthStatus = 'poor';
        else if (totalLeads < 5 || totalAgents === 0) healthStatus = 'average';
        const healthLabel = healthStatus === 'good' ? 'Good' : healthStatus === 'average' ? 'Average' : 'Needs attention';
        const conversionRate = totalLeads > 0 ? ((leads.convertedLeads / totalLeads) * 100).toFixed(1) : 0;
        return {
          id,
          name: agency.name || '',
          email: agency.contact?.email || '',
          phone: agency.contact?.phone || '',
          logo: agency.logo || null,
          isActive: true,
          hasNoAgents,
          hasNoLeads,
          healthStatus,
          healthLabel,
          totalAgents,
          activeAgents: agents.activeAgents || 0,
          totalProperties: props.totalProperties || 0,
          activeProperties: props.activeProperties || 0,
          totalLeads,
          convertedLeads: leads.convertedLeads || 0,
          conversionRate: Number(conversionRate),
          totalPropertyValue: props.totalPropertyValue || 0,
          daysSinceActivity: null
        };
      });
    }

    res.json({
      propertiesByStatus: formatStats(propertiesByStatus),
      propertiesByType: formatStats(propertiesByType),
      propertiesByListingType: formatStats(propertiesByListingType),
      propertiesByLocation: formatStats(propertiesByLocation),
      leadsByStatus: formatStats(leadsByStatus),
      leadsBySource: formatStats(leadsBySource),
      leadsByPriority: formatStats(leadsByPriority),
      usersByRole: formatStats(usersByRole),
      totalPropertyValue: totalPropertyValue[0]?.total || 0,
      recentActivity,
      agentPerformance: agentPerformance.map(a => ({
        ...a,
        name: `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.email,
        conversionRate: a.totalLeads > 0 ? ((a.convertedLeads / a.totalLeads) * 100).toFixed(1) : 0
      })),
      agencyAnalysis
    });
  } catch (error) {
    console.error('Get report stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/stats/customer
// @desc    Get statistics for the customer portal
// @access  Private
router.get('/customer', auth, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const userId = req.user.id;

    // 1. Get Property Stats (Purchased/Rented) and Transactions
    // Find leads for this customer
    const customerLeads = await Lead.find({ 'contact.email': userEmail }).select('_id status');
    const customerLeadIds = customerLeads.map(l => l._id);

    // Find ALL transactions for these leads (not just completed)
    const transactions = await mongoose.model('Transaction').find({
      lead: { $in: customerLeadIds }
    }).populate('property');

    const purchasedProperties = transactions.filter(t => t.type === 'sale' && t.status === 'completed').length;
    const rentedProperties = transactions.filter(t => t.type === 'rent' && t.status === 'completed').length;
    const bookedProperties = transactions.filter(t => t.status === 'pending').length;

    // 2. Get Inquiry Stats (Active Inquiries / Interested)
    // Filter out leads that have resulted in a COMPLETED transaction
    const completedTransactionLeadIds = transactions
      .filter(t => t.status === 'completed')
      .map(t => t.lead.toString());

    // Also exclude leads that are explicitly 'closed', 'lost', or 'junk'
    // But include 'booked' if no completed transaction exists (Just Booked = Interested)
    const totalInquiries = customerLeads.filter(l =>
      !completedTransactionLeadIds.includes(l._id.toString()) &&
      !['closed', 'lost', 'junk'].includes(l.status)
    ).length;

    // 3. Get Wishlist Count (Watchlist)
    const watchlistCount = await mongoose.model('Watchlist').countDocuments({ user: userId });

    // 4. Get Recent Activity
    const recentLeads = await Lead.find({
      'contact.email': userEmail,
      _id: { $nin: completedTransactionLeadIds }, // Exclude completed leads from recent inquiries list to avoid duplication/confusion
      status: { $nin: ['closed', 'lost', 'junk'] }
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('property', 'title images price location')
      .lean();

    const recentTransactions = transactions
      .sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate))
      .slice(0, 5);

    res.json({
      totalInquiries,
      purchasedProperties,
      rentedProperties,
      bookedProperties,
      watchlistCount,
      recentActivity: [
        ...recentLeads.map(l => ({
          type: 'inquiry',
          title: `Inquired about ${l.property?.title || 'a property'}`,
          time: l.createdAt,
          status: l.status,
          amount: l.property?.price?.sale || l.property?.price // Optional: Show price
        })),
        ...recentTransactions.map(t => ({
          type: 'transaction',
          title: `${t.type === 'sale' ? 'Purchased' : (t.type === 'rent' ? 'Rented' : 'Booked')} ${t.property?.title}`,
          time: t.transactionDate,
          status: t.status,
          amount: t.amount
        }))
      ].sort((a, b) => new Date(b.time) - new Date(a.time))
    });
  } catch (error) {
    console.error('Get customer stats error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

