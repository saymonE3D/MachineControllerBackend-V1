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

// Fetch and update node status
async function updateNodeStatus() {
  try {
    const response = await axios.get('https://rpi1.eagle3dstreaming.com/api/nodes');
    const nodes = response.data.nodes;
    
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
    console.error('Error updating node status:', error);
  }
}

// Get all nodes from API
app.get('/api/nodes', async (req, res) => {
  try {
    await updateNodeStatus();
    const nodes = await NodeStatus.find();
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all machines
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await Machine.find();
    res.json(machines);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new machine
app.post('/api/machines', async (req, res) => {
  try {
    console.log('Received machine data:', req.body);
    
    // Clean up the data
    const machineData = {
      name: req.body.name,
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
      status: 'unknown'
    };
    
    console.log('Processed machine data:', machineData);
    
    const machine = new Machine(machineData);
    const savedMachine = await machine.save();
    
    console.log('Saved machine:', savedMachine);
    
    await updateNodeStatus();
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
    
    // Clean up the data - only update basic machine info, not schedule
    const updateData = {
      name: req.body.name,
      nodeId: req.body.nodeId,
      startUrl: req.body.startUrl,
      stopUrl: req.body.stopUrl,
      lastUpdated: new Date()
    };
    
    const machine = await Machine.findByIdAndUpdate(req.params.id, updateData, { new: true });
    
    if (!machine) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    
    await updateNodeStatus();
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
    if (machine && machine.startUrl) {
      await axios.get(machine.startUrl);
      setTimeout(async () => {
        await updateNodeStatus();
      }, 2000);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Machine not found or no start URL' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop machine
app.post('/api/machines/:id/stop', async (req, res) => {
  try {
    const machine = await Machine.findById(req.params.id);
    if (machine && machine.stopUrl) {
      await axios.get(machine.stopUrl);
      setTimeout(async () => {
        await updateNodeStatus();
      }, 2000);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Machine not found or no stop URL' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule checker - runs every minute
cron.schedule('* * * * *', async () => {
  try {
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
          console.log(`Starting machine: ${machine.name} at ${currentTime}`);
          await axios.get(machine.startUrl);
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
          console.log(`Stopping machine: ${machine.name} at ${currentTime}`);
          await axios.get(machine.stopUrl);
        }
      }
    }
  } catch (error) {
    console.error('Schedule error:', error);
  }
});

// Update node status every 30 seconds
setInterval(updateNodeStatus, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  updateNodeStatus(); // Initial update
});