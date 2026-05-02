const express = require('express');
const { Kafka } = require('kafkajs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');

dotenv.config();

const brokers = process.env.KAFKA_BROKERS ? [process.env.KAFKA_BROKERS] : ['localhost:9092'];
const tenants = ['tenant-acme', 'tenant-globex', 'tenant-initech'];

// --- Gateway Implementation ---
const app = express();
app.use(express.json());

// Cache producers per tenant
const producers = {};

// Store recent logs for the dashboard
const recentLogs = [];

function addLog(type, details) {
  recentLogs.unshift({ type, details, timestamp: new Date().toISOString() });
  if (recentLogs.length > 50) recentLogs.pop();
}

async function getProducer(tenantId) {
  if (producers[tenantId]) return producers[tenantId];
  
  const kafka = new Kafka({
    clientId: `gateway-${tenantId}`,
    brokers: brokers,
    sasl: {
      mechanism: 'scram-sha-256',
      username: tenantId,
      password: `${tenantId}-password`, // Fixed password strategy for demo
    },
  });
  
  const producer = kafka.producer();
  await producer.connect();
  producers[tenantId] = producer;
  return producer;
}

// Special Admin Producer for violations
const adminKafka = new Kafka({
  clientId: 'gateway-admin',
  brokers: brokers,
  sasl: {
    mechanism: 'scram-sha-256',
    username: 'admin',
    password: 'admin-password',
  },
});
const adminProducer = adminKafka.producer();

app.post('/events', async (req, res) => {
  const tenantId = req.header('X-Tenant-ID');
  const payload = req.body;

  if (!tenantId || !tenants.includes(tenantId)) {
    console.warn(`Unauthorized tenant access attempt: ${tenantId}`);
    addLog('violation', `Unauthorized attempt from ${req.ip} for tenant ${tenantId}`);
    
    // Log violation to audit.violations
    await adminProducer.connect();
    await adminProducer.send({
      topic: 'audit.violations',
      messages: [{ 
        value: JSON.stringify({
          source_ip: req.ip,
          attempted_tenant_id: tenantId,
          timestamp: new Date().toISOString(),
          payload: payload
        })
      }],
    });
    
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const producer = await getProducer(tenantId);
    await producer.send({
      topic: `audit.${tenantId}.events`,
      messages: [{ value: JSON.stringify(payload) }],
    });
    
    addLog('accepted', `Valid event processed for ${tenantId}`);
    return res.status(202).send('Accepted');
  } catch (error) {
    console.error(`Error producing for ${tenantId}:`, error);
    return res.status(500).send('Internal Server Error');
  }
});

app.get('/dashboard', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Audit Log Dashboard</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
        <style>
          body { font-family: 'Inter', sans-serif; background-color: #0b0f19; color: #f8fafc; padding: 2rem; margin: 0; }
          .container { max-width: 1000px; margin: 0 auto; }
          .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; border-bottom: 1px solid #1e293b; padding-bottom: 1rem; }
          .card { border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
          
          /* System Status Card */
          .status-panel { background: #1e293b; border: 1px solid #334155; }
          .badge { padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
          .badge-system { background: #3b82f6; color: #eff6ff; }
          
          /* Terminal Styles */
          .terminal { background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 1rem; font-family: 'Consolas', 'Monaco', monospace; height: 500px; overflow-y: auto; }
          .log-line { margin-bottom: 6px; font-size: 13px; line-height: 1.5; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px; }
          .log-time { color: #64748b; margin-right: 10px; }
          .log-type-accepted { color: #10b981; font-weight: bold; margin-right: 10px; }
          .log-type-violation { color: #ef4444; font-weight: bold; margin-right: 10px; }
          .log-msg { color: #e2e8f0; }

          h1 { margin: 0; font-size: 24px; font-weight: 600; }
          h3 { color: #cbd5e1; font-weight: 400; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 1rem; }
        </style>
        <script>
          setTimeout(() => window.location.reload(), 10000);
        </script>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Audit Log Activity Gateway</h1>
            <div style="font-size: 14px; color: #94a3b8;">Auto-refreshing every 10s</div>
          </div>
          
          <div class="card status-panel">
            <h3>Infrastructure Status</h3>
            <div style="display: flex; gap: 15px;">
              <span class="badge badge-system">KAFKA: SASL_SCRAM</span>
              <span class="badge badge-system">ACL ENFORCEMENT: ACTIVE</span>
              <span class="badge badge-system">MINIO ARCHIVER: SCANNING</span>
            </div>
          </div>

          <h3>Recent Events & Violations</h3>
          <p style="color: #94a3b8; font-size: 14px;">(Check server logs for real-time Kafka stream details)</p>
          
          <div class="terminal">
          ${recentLogs.length === 0 ? `
            <div class="log-line">
              <span class="log-time">[${new Date().toISOString()}]</span> 
              <span class="log-type-accepted">[SYSTEM]</span> 
              <span class="log-msg">Gateway is listening on port ${port}... waiting for events.</span>
            </div>
          ` : recentLogs.map(log => `
            <div class="log-line">
              <span class="log-time">[${new Date(log.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}]</span> 
              <span class="${log.type === 'accepted' ? 'log-type-accepted' : 'log-type-violation'}">[${log.type === 'accepted' ? 'ACCEPTED' : 'SECURITY_VIOLATION'}]</span> 
              <span class="log-msg">${log.details}</span>
            </div>
          `).join('')}
          </div>
        </div>
      </body>
    </html>
  `);
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`Gateway listening on port ${port}`);
});

// --- Archiver Implementation ---
const s3Client = new S3Client({
  endpoint: `http://${process.env.MINIO_ENDPOINT || 'localhost:9000'}`,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretAccessKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  },
  forcePathStyle: true,
});

const archiverKafka = new Kafka({
  clientId: 'archiver',
  brokers: brokers,
  sasl: {
    mechanism: 'scram-sha-256',
    username: 'admin',
    password: 'admin-password',
  },
});

const consumer = archiverKafka.consumer({ groupId: 'archiver-group' });

async function startArchiver() {
  await consumer.connect();
  // Subscribe to all tenant audit topics
  await consumer.subscribe({ topics: tenants.map(t => `audit.${t}.events`), fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const timestamp = parseInt(message.timestamp);
      const now = Date.now();
      const ageMinutes = (now - timestamp) / (1000 * 60);

      // Archival Interval (5 minutes)
      const interval = parseInt(process.env.ARCHIVAL_INTERVAL_MINUTES) || 5;
      if (ageMinutes >= interval) {
        const offset = message.offset.padStart(20, '0');
        const key = `${topic}/partition=${partition}/${offset}.json`;
        
        console.log(`Archiving message ${offset} from ${topic} to ${key}`);

        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: 'kafka-archive',
            Key: key,
            Body: message.value.toString(),
            ContentType: 'application/json',
          }));
        } catch (err) {
          console.error(`Failed to archive message: ${err.message}`);
        }
      }
    },
  });
}

// Start Archiver in background
startArchiver().catch(err => console.error('Archiver error:', err));
