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
      if (ageMinutes >= (parseInt(process.env.ARCHIVAL_INTERVAL_MINUTES) || 5)) {
        const offset = message.offset.padStart(20, '0');
        const key = `kafka-archive/${topic}/partition=${partition}/${offset}.json`;
        
        console.log(`Archiving message ${offset} from ${topic} to ${key}`);

        try {
          await s3Client.send(new PutObjectCommand({
            Bucket: 'kafka-archive',
            Key: `${topic}/partition=${partition}/${offset}.json`,
            Body: message.value.toString(),
            ContentType: 'application/json',
          }));
          // In a real system, we might commit the offset after successful archival
        } catch (err) {
          console.error(`Failed to archive message: ${err.message}`);
        }
      }
    },
  });
}

// Start Archiver in background
startArchiver().catch(err => console.error('Archiver error:', err));
