const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB connection
mongoose.connect('mongodb+srv://saymon_db_user:sS3hv6KsQL3mZOUr@cluster0.2v6cd3c.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Machine Schema
const machineSchema = new mongoose.Schema({
  name: { type: String, required: true },
  nodeId: { type: String, required: true },
  startUrl: { type: String, required: true },
  stopUrl: { type: String, required: true },
  startSchedule: {
    enabled: { type: Boolean, default: false },
    type: { type: String, default: 'daily' }, // 'daily' or 'range'
    time: { type: String, default: '' }, // HH:MM format
    fromDate: { type: Date, default: null },
    toDate: { type: Date, default: null }
  },
  stopSchedule: {
    enabled: { type: Boolean, default: false },
    type: { type: String, default: 'daily' }, // 'daily' or 'range'
    time: { type: String, default: '' }, // HH:MM format
    fromDate: { type: Date, default: null },
    toDate: { type: Date, default: null }
  },
  status: { type: String, default: 'unknown' },
  lastUpdated: { type: Date, default: Date.now }
});

const Machine = mongoose.model('Machine', machineSchema);

// Node status schema
const nodeStatusSchema = new mongoose.Schema({
  nodeId: String,
  name: String,
  os: String,
  ip: String,
  lastbootuptime: String,
  status: String,
  conn: Number,
  pwr: Number,
  lastUpdated: { type: Date, default: Date.now }
});

const NodeStatus = mongoose.model('NodeStatus', nodeStatusSchema);

// Global variable to track node API status
let nodeApiStatus = {
  isWorking: true,
  lastError: null,
  lastSuccessful: new Date(),
  consecutiveFailures: 0
};

// Fetch and update node status with error handling
async function updateNodeStatus() {
  try {
    console.log('Attempting to fetch node status...');
    const response = await axios.get('https://rpi1.eagle3dstreaming.com/api/nodes', {
      timeout: 10000 // 10 second timeout
    });
    
    const nodes = response.data.nodes;
    
    // Reset error tracking on success
    nodeApiStatus.isWorking = true;
    nodeApiStatus.lastError = null;
    nodeApiStatus.lastSuccessful = new Date();
    nodeApiStatus.consecutiveFailures = 0;
    
    console.log(`Successfully fetched ${Object.keys(nodes).length} nodes`);
    
    for (const [nodeId, nodeData] of Object.entries(nodes)) {
      await NodeStatus.findOneAndUpdate(
        { nodeId },
        {
          nodeId,
          name: nodeData.name,
          os: nodeData.os,
          ip: nodeData.ip,
          lastbootuptime: nodeData.lastbootuptime,
          status: nodeData.status,
          conn: nodeData.conn || 0,
          pwr: nodeData.pwr || 0,
          lastUpdated: new Date()
        },
        { upsert: true }
      );
    }
  } catch (error) {
    nodeApiStatus.isWorking = false;
    nodeApiStatus.lastError = error.message;
    nodeApiStatus.consecutiveFailures++;
    
    console.error('Error updating node status:', {
      message: error.message,
      consecutiveFailures: nodeApiStatus.consecutiveFailures,
      lastSuccessful: nodeApiStatus.lastSuccessful
    });
    
    // If it's been down for more than 5 consecutive failures, log a warning
    if (nodeApiStatus.consecutiveFailures >= 5) {
      console.warn('Node API has been down for 5+ consecutive attempts');
    }
  }
}

// Get all nodes from database (no more API calls)
app.get('/api/nodes', async (req, res) => {
  try {
    // Get all nodes from database (cached data)
    const nodes = await NodeStatus.find();
    
    // If no nodes in database, return empty array with status
    if (nodes.length === 0) {
      return res.json({
        nodes: [],
        apiStatus: {
          isWorking: false,
          message: 'No node data available in database',
          lastError: nodeApiStatus.lastError,
          consecutiveFailures: nodeApiStatus.consecutiveFailures
        }
      });
    }
    
    // Return nodes with API status
    res.json({
      nodes: nodes,
      apiStatus: {
        isWorking: nodeApiStatus.isWorking,
        message: nodeApiStatus.isWorking ? 'Node Status API is working' : 'Node Status API is not working - showing cached data',
        lastError: nodeApiStatus.lastError,
        lastSuccessful: nodeApiStatus.lastSuccessful,
        consecutiveFailures: nodeApiStatus.consecutiveFailures
      }
    });
  } catch (error) {
    console.error('Error in /api/nodes endpoint:', error);
    
    res.status(500).json({ 
      error: 'Database error',
      dbError: error.message,
      apiStatus: nodeApiStatus
    });
  }
});

// Get all machines with their status from database
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await Machine.find();
    const nodes = await NodeStatus.find();
    
    // Update machine status from node data
    const updatedMachines = machines.map(machine => {
      const nodeStatus = nodes.find(n => n.nodeId === machine.nodeId);
      return {
        ...machine.toObject(),
        status: nodeStatus ? nodeStatus.status : 'unknown'
      };
    });
    
    res.json({
      machines: updatedMachines,
      nodeApiStatus: {
        isWorking: nodeApiStatus.isWorking,
        message: nodeApiStatus.isWorking ? 'Node Status API is working' : 'Node Status API is not working',
        lastError: nodeApiStatus.lastError,
        consecutiveFailures: nodeApiStatus.consecutiveFailures
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new machine
app.post('/api/machines', async (req, res) => {
  try {
    console.log('Received machine data:', req.body);
    
    // Get machine name from database instead of API call
    const nodeStatus = await NodeStatus.findOne({ nodeId: req.body.nodeId });
    if (!nodeStatus) {
      return res.status(400).json({ error: 'Node not found in database. Node data may not be updated yet.' });
    }
    
    // Clean up the data
    const machineData = {
      name: nodeStatus.name, // Use name from database
      nodeId: req.body.nodeId,
      startUrl: req.body.startUrl,
      stopUrl: req.body.stopUrl,
      startSchedule: {
        enabled: false,
        type: 'daily',
        time: '',
        fromDate: null,
        toDate: null
      },
      stopSchedule: {
        enabled: false,
        type: 'daily',
        time: '',
        fromDate: null,
        toDate: null
      },
      status: nodeStatus.status // Set initial status from database
    };
    
    console.log('Processed machine data:', machineData);
    
    const machine = new Machine(machineData);
    const savedMachine = await machine.save();
    
    console.log('Saved machine:', savedMachine);
    
    res.json(savedMachine);
  } catch (error) {
    console.error('Error saving machine:', error);
    res.status(500).json({ error: error.message, details: error });
  }
});

// Update machine schedule
app.put('/api/machines/:id/schedule', async (req, res) => {
  try {
    console.log('Updating schedule for machine:', req.params.id);
    console.log('Schedule data:', req.body);
    
    const scheduleData = {
      startSchedule: {
        enabled: req.body.startSchedule?.enabled || false,
        type: req.body.startSchedule?.type || 'daily',
        time: req.body.startSchedule?.time || '',
        fromDate: req.body.startSchedule?.fromDate ? new Date(req.body.startSchedule.fromDate) : null,
        toDate: req.body.startSchedule?.toDate ? new Date(req.body.startSchedule.toDate) : null
      },
      stopSchedule: {
        enabled: req.body.stopSchedule?.enabled || false,
        type: req.body.stopSchedule?.type || 'daily',
        time: req.body.stopSchedule?.time || '',
        fromDate: req.body.stopSchedule?.fromDate ? new Date(req.body.stopSchedule.fromDate) : null,
        toDate: req.body.stopSchedule?.toDate ? new Date(req.body.stopSchedule.toDate) : null
      },
      lastUpdated: new Date()
    };
    
    const machine = await Machine.findByIdAndUpdate(req.params.id, scheduleData, { new: true });
    
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    
    res.json(machine);
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ error: error.message, details: error });
  }
});

// Update machine
app.put('/api/machines/:id', async (req, res) => {
  try {
    console.log('Updating machine with ID:', req.params.id);
    console.log('Update data:', req.body);
    
    // Get machine name from database instead of API call
    const nodeStatus = await NodeStatus.findOne({ nodeId: req.body.nodeId });
    if (!nodeStatus) {
      return res.status(400).json({ error: 'Node not found in database. Node data may not be updated yet.' });
    }
    
    // Clean up the data - only update basic machine info, not schedule
    const updateData = {
      name: nodeStatus.name, // Use name from database
      nodeId: req.body.nodeId,
      startUrl: req.body.startUrl,
      stopUrl: req.body.stopUrl,
      lastUpdated: new Date()
    };
    
    const machine = await Machine.findByIdAndUpdate(req.params.id, updateData, { new: true });
    
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    
    res.json(machine);
  } catch (error) {
    console.error('Error updating machine:', error);
    res.status(500).json({ error: error.message, details: error });
  }
});

// Delete machine
app.delete('/api/machines/:id', async (req, res) => {
  try {
    await Machine.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start machine
app.post('/api/machines/:id/start', async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id);
    if (!machine || !machine.startUrl) {
      return res.status(404).json({ error: 'Machine not found or no start URL' });
    }

    console.log(`[START] Calling start URL for machine: ${machine.name} (${machine.nodeId})`);
    console.log(`[START] URL: ${machine.startUrl}`);
    
    try {
      const response = await axios.get(machine.startUrl);
      console.log(`[START] ✓ API call successful for ${machine.name}`);
      res.json({ 
        success: true, 
        message: 'Machine started successfully',
        alreadyRunning: false
      });
    } catch (error) {
      // Check if it's a 406 error (machine already running)
      if (error.response && error.response.status === 406) {
        console.log(`[START] ℹ Machine ${machine.name} is already running`);
        res.json({ 
          success: true, 
          message: 'Machine is already running',
          alreadyRunning: true
        });
      } else {
        // Real error - propagate it
        throw error;
      }
    }
  } catch (error) {
    console.error(`[START] ✗ API call failed: ${error.message}`);
    res.status(500).json({ 
      error: 'Failed to start machine',
      details: error.message 
    });
  }
});

// Stop machine
app.post('/api/machines/:id/stop', async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id);
    if (!machine || !machine.stopUrl) {
      return res.status(404).json({ error: 'Machine not found or no stop URL' });
    }

    console.log(`[STOP] Calling stop URL for machine: ${machine.name} (${machine.nodeId})`);
    console.log(`[STOP] URL: ${machine.stopUrl}`);
    
    try {
      const response = await axios.get(machine.stopUrl);
      console.log(`[STOP] ✓ API call successful for ${machine.name}`);
      res.json({ 
        success: true, 
        message: 'Machine stopped successfully',
        alreadyStopped: false
      });
    } catch (error) {
      // Check if it's a 400 error (machine already stopped)
      if (error.response && error.response.status === 400) {
        console.log(`[STOP] ℹ Machine ${machine.name} is already stopped`);
        res.json({ 
          success: true, 
          message: 'Machine is already stopped',
          alreadyStopped: true
        });
      } else {
        // Real error - propagate it
        throw error;
      }
    }
  } catch (error) {
    console.error(`[STOP] ✗ API call failed: ${error.message}`);
    res.status(500).json({ 
      error: 'Failed to stop machine',
      details: error.message 
    });
  }
});



async function fetchWithRetry(url, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await axios.get(url);
      return { success: true, data: resp.data };
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;

      console.log(`Attempt ${attempt} failed:`, err.message);

      // If 400 error, machine is already in desired state - treat as success
      if (status === 400) {
        return { 
          success: true, 
          alreadyInState: true,
          message: 'Machine already in desired state' 
        };
      }

      // If other client-side error (<500), return it immediately (don't retry)
      if (status && status < 500) {
        return { success: false, error: err.message, data };
      }

      // If last attempt or status >= 500 or network error → maybe retry
      if (attempt === maxRetries) {
        return { success: false, error: 'All retry attempts failed' };
      }

      // Small delay between retries
      await new Promise(res => setTimeout(res, 500));
    }
  }
}

// Combined scheduler - runs every minute
let isSchedulerRunning = false;

cron.schedule('* * * * *', async () => {
  // Prevent overlapping executions
  if (isSchedulerRunning) {
    console.log('[SCHEDULER] Skipping - previous execution still running');
    return;
  }
  
  isSchedulerRunning = true;
  const startTime = Date.now();
  
  try {
    // 1. Update node status first
    console.log('[SCHEDULER] Updating node status...');
    await updateNodeStatus();
    
    // 2. Check and execute machine schedules
    console.log('[SCHEDULER] Checking machine schedules...');
    const machines = await Machine.find({
      $or: [
        { 'startSchedule.enabled': true },
        { 'stopSchedule.enabled': true }
      ]
    });
    
    const now = new Date();
    const currentTime = now.toTimeString().substr(0, 5);
    const currentDate = now.toISOString().split('T')[0];
    
    for (const machine of machines) {
      // Check start schedule
      if (machine.startSchedule.enabled && machine.startSchedule.time === currentTime) {
        const schedule = machine.startSchedule;
        let shouldStart = false;
        
        if (schedule.type === 'daily') {
          shouldStart = true;
        } else if (schedule.type === 'range') {
          const fromDate = new Date(schedule.fromDate).toISOString().split('T')[0];
          const toDate = new Date(schedule.toDate).toISOString().split('T')[0];
          shouldStart = currentDate >= fromDate && currentDate <= toDate;
        }
        
        if (shouldStart) {
          console.log(`[SCHEDULED START] Starting machine: ${machine.name} at ${currentTime}`);
          console.log(`[SCHEDULED START] URL: ${machine.startUrl}`);

          const response = await fetchWithRetry(machine.startUrl);

          if (response.success) {
            if (response.alreadyInState) {
              console.log(`[SCHEDULED START] ℹ Machine ${machine.name} is already running`);
            } else {
              console.log(`[SCHEDULED START] ✓ Successfully started ${machine.name}`);
            }
          } else {
            console.error(`[SCHEDULED START] ✗ Failed to start ${machine.name}: ${response.error}`);
          }
        }
      }
      
      // Check stop schedule
      if (machine.stopSchedule.enabled && machine.stopSchedule.time === currentTime) {
        const schedule = machine.stopSchedule;
        let shouldStop = false;
        
        if (schedule.type === 'daily') {
          shouldStop = true;
        } else if (schedule.type === 'range') {
          const fromDate = new Date(schedule.fromDate).toISOString().split('T')[0];
          const toDate = new Date(schedule.toDate).toISOString().split('T')[0];
          shouldStop = currentDate >= fromDate && currentDate <= toDate;
        }
        
        if (shouldStop) {
          console.log(`[SCHEDULED STOP] Stopping machine: ${machine.name} at ${currentTime}`);
          console.log(`[SCHEDULED STOP] URL: ${machine.stopUrl}`);
          
          const response = await fetchWithRetry(machine.stopUrl);

          if (response.success) {
            if (response.alreadyInState) {
              console.log(`[SCHEDULED STOP] ℹ Machine ${machine.name} is already stopped`);
            } else {
              console.log(`[SCHEDULED STOP] ✓ Successfully stopped ${machine.name}`);
            }
          } else {
            console.error(`[SCHEDULED STOP] ✗ Failed to stop ${machine.name}: ${response.error}`);
          }
        }
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`[SCHEDULER] Completed in ${duration}ms`);
    
  } catch (error) {
    console.error('[SCHEDULER] Error:', error);
  } finally {
    isSchedulerRunning = false;
  }
});

const PORT = process.env.PORT || 7001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Initial update - don't fail startup if it fails
  updateNodeStatus().catch(error => {
    console.log('Initial node status update failed, but server started successfully');
  });
});