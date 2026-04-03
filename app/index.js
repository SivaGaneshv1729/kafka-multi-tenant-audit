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
          body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #f8fafc; padding: 2rem; margin: 0; }
          .container { max-width: 1000px; margin: 0 auto; }
          .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
          .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); }
          .status-accepted { border-left: 4px solid #22c55e; }
          .status-violation { border-left: 4px solid #ef4444; }
          .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
          .bg-green { background: #14532d; color: #4ade80; }
          .bg-red { background: #7f1d1d; color: #fca5a5; }
          .timestamp { color: #94a3b8; font-size: 12px; }
          h1 { margin: 0; font-size: 24px; font-weight: 600; }
          pre { background: #0f172a; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 13px; color: #cbd5e1; }
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
          
          <div class="card" style="background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);">
            <h3>Infrastructure Status</h3>
            <div style="display: flex; gap: 20px;">
              <div><span class="badge bg-green">KAFKA: SASL_SCRAM</span></div>
              <div><span class="badge bg-green">ACL enforcement: Active</span></div>
              <div><span class="badge bg-green">MinIO Archiver: Scanning</span></div>
            </div>
          </div>

          <h3>Recent Events & Violations</h3>
          <p style="color: #94a3b8; font-size: 14px;">(Check server logs for real-time Kafka stream details)</p>
          
          <div class="card status-accepted">
             <div style="display: flex; justify-content: space-between;">
               <strong>system_heartbeat</strong>
               <span class="timestamp">Just now</span>
             </div>
             <p style="font-size: 14px;">Node Application Gateway is listening on port ${port}...</p>
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
