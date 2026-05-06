/**
 * By Babes Dashboard Backend API
 * 
 * Node.js + Express server that:
 * - Fetches campaign data from Meta API
 * - Analyzes with Claude AI
 * - Serves data to React dashboard
 * - Runs daily automated syncs
 * 
 * Deploy to: Heroku, Vercel, AWS Lambda, Railway, or Render
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());

// Simple in-memory cache (replace with Redis for production)
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Active sync jobs
const syncJobs = new Map();

// ===== UTILITY FUNCTIONS =====

function getFromCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setInCache(key, data, duration = CACHE_DURATION) {
  cache.set(key, {
    data,
    expiry: Date.now() + duration
  });
}

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }
  if (token !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }
  next();
}

// ===== META API FUNCTIONS =====

async function fetchFromMeta(endpoint, method = 'GET', body = null) {
  const url = `https://graph.instagram.com/v18.0${endpoint}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`Meta API error: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Meta API error:', error);
    throw error;
  }
}

async function getMetaCampaigns() {
  const fields = 'id,name,status,daily_budget,start_time,stop_time';
  const data = await fetchFromMeta(
    `/${process.env.META_AD_ACCOUNT_ID}/campaigns?fields=${fields}&access_token=${process.env.META_ACCESS_TOKEN}`
  );
  return data.data || [];
}

async function getCampaignInsights(campaignId) {
  const fields = 'spend,impressions,clicks,actions,action_values';
  const data = await fetchFromMeta(
    `/${campaignId}/insights?fields=${fields}&access_token=${process.env.META_ACCESS_TOKEN}`
  );
  
  const insights = {};
  if (data.data && data.data.length > 0) {
    data.data.forEach(item => {
      insights[item.name] = item.values[0]?.value || 0;
    });
  }
  return insights;
}

// ===== CLAUDE API FUNCTIONS =====

async function analyzeWithClaude(campaignData) {
  if (!process.env.CLAUDE_API_KEY) {
    console.log('Claude API key not set, using template analysis');
    return generateTemplateAnalysis(campaignData);
  }

  const prompt = `You are an expert performance marketer analyzing lash serum ad campaigns for "By Babes" brand.

CAMPAIGN DATA:
${JSON.stringify(campaignData, null, 2)}

Provide specific, actionable optimization recommendations. Return ONLY valid JSON:

{
  "summary": "Brief health summary of campaigns",
  "recommendations": [
    {
      "priority": "HIGH|MEDIUM|LOW",
      "action": "PAUSE|SCALE|OPTIMIZE|TEST",
      "campaign": "Campaign name",
      "reason": "Why with metrics",
      "expected_impact": "Quantified outcome"
    }
  ],
  "budget_reallocation": [
    {
      "from_campaign": "Name",
      "to_campaign": "Name",
      "amount_daily": 25,
      "roi_improvement": "Why this helps"
    }
  ]
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      console.error('Claude API error:', response.statusText);
      return generateTemplateAnalysis(campaignData);
    }

    const data = await response.json();
    const text = data.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.error('Claude analysis error:', error);
  }

  return generateTemplateAnalysis(campaignData);
}

function generateTemplateAnalysis(campaignData) {
  const recommendations = [];
  
  campaignData.forEach(campaign => {
    if (campaign.roas < 1.5) {
      recommendations.push({
        priority: 'HIGH',
        action: 'PAUSE',
        campaign: campaign.name,
        reason: `ROAS of ${campaign.roas.toFixed(2)}:1 below profitability threshold. High CPC indicates poor targeting.`,
        expected_impact: `Save £${Math.round(campaign.spend)}/month`
      });
    } else if (campaign.roas >= 4) {
      recommendations.push({
        priority: 'HIGH',
        action: 'SCALE',
        campaign: campaign.name,
        reason: `Strong ROAS (${campaign.roas.toFixed(2)}:1) with efficient CTR. Ready to scale.`,
        expected_impact: `Scale by 25-30% for additional £${Math.round(campaign.revenue * 0.3)}/month`
      });
    }
  });

  return {
    summary: `${campaignData.length} campaigns with average ROAS of ${(
      campaignData.reduce((sum, c) => sum + c.roas, 0) / campaignData.length
    ).toFixed(2)}:1`,
    recommendations: recommendations.slice(0, 5),
    budget_reallocation: []
  };
}

// ===== API ENDPOINTS =====

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * GET /api/dashboard
 * Main dashboard endpoint - returns all metrics and recommendations
 */
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    // Check cache first
    const cached = getFromCache('dashboard');
    if (cached) {
      return res.json(cached);
    }

    // Fetch campaigns from Meta
    console.log('Fetching campaigns from Meta API...');
    const campaigns = await getMetaCampaigns();
    console.log(`Found ${campaigns.length} campaigns`);

    // Get insights for each campaign
    const campaignData = [];
    for (const campaign of campaigns) {
      const insights = await getCampaignInsights(campaign.id);
      
      const spend = parseFloat(insights.spend || 0);
      const revenue = parseFloat(insights.action_values?.slice(-1)[0]?.value || 0);
      const impressions = parseInt(insights.impressions || 0);
      const clicks = parseInt(insights.clicks || 0);
      const conversions = parseInt(insights.actions?.slice(-1)[0]?.value || 0);

      campaignData.push({
        id: campaign.id,
        name: campaign.name,
        persona: '', // No persona assignment
        status: campaign.status,
        daily_budget: campaign.daily_budget / 100,
        spend: spend,
        impressions: impressions,
        clicks: clicks,
        conversions: conversions,
        revenue: revenue,
        roas: spend > 0 ? revenue / spend : 0,
        cpc: clicks > 0 ? spend / clicks : 0,
        cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0
      });
    }

    // Calculate totals
    const totalSpend = campaignData.reduce((sum, c) => sum + c.spend, 0);
    const totalRevenue = campaignData.reduce((sum, c) => sum + c.revenue, 0);

    // Get AI analysis
    console.log('Analyzing with Claude...');
    const analysis = await analyzeWithClaude(campaignData);

    // Build response
    const dashboard = {
      timestamp: new Date().toISOString(),
      total_spend: totalSpend,
      total_revenue: totalRevenue,
      overall_roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
      campaigns: campaignData.sort((a, b) => b.roas - a.roas),
      recommendations: analysis.recommendations || [],
      budget_moves: analysis.budget_reallocation || []
    };

    // Cache for 5 minutes
    setInCache('dashboard', dashboard);
    
    res.json(dashboard);
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({
      error: 'Failed to fetch dashboard data',
      details: error.message
    });
  }
});

/**
 * POST /api/sync
 * Manually trigger a data sync
 */
app.post('/api/sync', requireAuth, async (req, res) => {
  const syncId = uuidv4();
  const syncJob = {
    id: syncId,
    status: 'processing',
    started_at: new Date().toISOString(),
    campaigns_synced: 0,
    errors: []
  };

  syncJobs.set(syncId, syncJob);

  // Run sync in background
  performSync(syncId).catch(error => {
    syncJob.status = 'failed';
    syncJob.errors.push(error.message);
    console.error(`Sync ${syncId} failed:`, error);
  });

  res.status(202).json({
    sync_id: syncId,
    status: 'processing',
    estimated_completion: new Date(Date.now() + 5 * 60000).toISOString()
  });
});

async function performSync(syncId) {
  const syncJob = syncJobs.get(syncId);
  
  try {
    console.log(`Starting sync ${syncId}...`);
    
    const campaigns = await getMetaCampaigns();
    let synced = 0;

    for (const campaign of campaigns) {
      try {
        await getCampaignInsights(campaign.id);
        synced++;
      } catch (error) {
        syncJob.errors.push(`Campaign ${campaign.id}: ${error.message}`);
      }
    }

    // Clear dashboard cache to force refresh
    cache.delete('dashboard');

    syncJob.status = 'completed';
    syncJob.completed_at = new Date().toISOString();
    syncJob.campaigns_synced = synced;
    
    console.log(`Sync ${syncId} completed. Synced ${synced}/${campaigns.length} campaigns`);
  } catch (error) {
    syncJob.status = 'failed';
    syncJob.errors.push(error.message);
    throw error;
  }
}

/**
 * GET /api/sync/:syncId
 * Check status of a sync job
 */
app.get('/api/sync/:syncId', requireAuth, (req, res) => {
  const syncJob = syncJobs.get(req.params.syncId);
  
  if (!syncJob) {
    return res.status(404).json({ error: 'Sync job not found' });
  }

  res.json(syncJob);
});

/**
 * GET /api/tiers
 * Get performance metrics by tier
 */
app.get('/api/tiers', requireAuth, async (req, res) => {
  try {
    const dashboard = getFromCache('dashboard');
    if (!dashboard) {
      // Fetch fresh if not cached
      const fresh = await fetch(`http://localhost:${PORT}/api/dashboard`, {
        headers: { 'Authorization': `Bearer ${process.env.API_KEY}` }
      }).then(r => r.json());
      
      res.json(getPerformanceTiers(fresh.campaigns));
      return;
    }

    res.json(getPerformanceTiers(dashboard.campaigns));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== HELPER FUNCTIONS =====

function getPerformanceTiers(campaigns) {
  const sorted = campaigns.sort((a, b) => b.roas - a.roas);
  
  const high = sorted.filter(c => c.roas >= 4);
  const medium = sorted.filter(c => c.roas >= 2.5 && c.roas < 4);
  const low = sorted.filter(c => c.roas < 2.5);

  const getTierMetrics = (tier) => {
    const totalSpend = tier.reduce((sum, c) => sum + c.spend, 0);
    const totalRevenue = tier.reduce((sum, c) => sum + c.revenue, 0);
    const totalImpressions = tier.reduce((sum, c) => sum + c.impressions, 0);
    
    return {
      campaigns_count: tier.length,
      total_spend: totalSpend,
      total_revenue: totalRevenue,
      roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
      conversions: tier.reduce((sum, c) => sum + c.conversions, 0),
      impressions: totalImpressions,
      pct_of_total_spend: (totalSpend / campaigns.reduce((sum, c) => sum + c.spend, 0)) * 100
    };
  };

  return {
    tiers: [
      { tier: 'Top Performers', icon: '🟢', ...getTierMetrics(high) },
      { tier: 'Medium Performers', icon: '🟡', ...getTierMetrics(medium) },
      { tier: 'Underperformers', icon: '🔴', ...getTierMetrics(low) }
    ]
  };
}

// ===== ERROR HANDLING =====

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ===== START SERVER =====

app.listen(PORT, () => {
  console.log(`
🚀 By Babes Dashboard Backend
============================
Running on: http://localhost:${PORT}
API Key: ${process.env.API_KEY ? '✓ Set' : '⚠ Missing'}
Meta Token: ${process.env.META_ACCESS_TOKEN ? '✓ Set' : '⚠ Missing'}
Claude Key: ${process.env.CLAUDE_API_KEY ? '✓ Set' : '⚠ Optional'}

Endpoints:
  GET  /api/health      - Health check
  GET  /api/dashboard   - Main dashboard (requires auth)
  POST /api/sync        - Trigger sync (requires auth)
  GET  /api/sync/:id    - Check sync status
  GET  /api/personas    - Get persona metrics
  `);
});

module.exports = app;
