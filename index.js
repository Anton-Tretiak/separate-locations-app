require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const SHOP = process.env.SHOP;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const GRAPHQL_URL = `https://${SHOP}/admin/api/2023-07/graphql.json`;
const PORT = process.env.PORT || 3340;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL; // e.g., public URL to this app's /health
const KEEPALIVE_INTERVAL_MS = parseInt(process.env.KEEPALIVE_INTERVAL_MS || '120000', 10); // 2 minutes default

const warehouseLocationName = "Omaha Pneumatic Equipment Company";
const vendorLocationName = "Vendor";
const warehouseMetafieldKey = "omaha_product_inventory";
const vendorMetafieldKey = "vendor_product_inventory";

const updateMetafieldMutation = (productId, warehouseQuantity, vendorQuantity) => `
  mutation {
    metafieldsSet(metafields: [{
      ownerId: "${productId}",
      namespace: "custom",
      key: "${warehouseMetafieldKey}",
      value: "${warehouseQuantity}",
      type: "number_integer"
    },
    {
      ownerId: "${productId}",
      namespace: "custom",
      key: "${vendorMetafieldKey}",
      value: "${vendorQuantity}",
      type: "number_integer"
    }]) {
      metafields {
        id
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const fetchMetafieldsQuery = (productId) => `
  {
    product(id: "${productId}") {
      metafields(first: 30, namespace: "custom") {
        edges {
          node {
            key
            value
          }
        }
      }
    }
  }
`;

const fetchProducts = async (cursor = null) => {
  const query = `
    {
      products(first: 100${cursor ? `, after: "${cursor}"` : ''}) {
        edges {
          node {
            id
            title
            variants(first: 50) {
              edges {
                node {
                  id
                  inventoryItem {
                    id
                    inventoryLevels(first: 5) {
                      edges {
                        node {
                          location {
                            id
                            name
                          }
                          quantities (names: ["available"]) {
                            quantity
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const response = await axios({
    method: 'post',
    url: GRAPHQL_URL,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    data: { query },
  });

  // console.log(JSON.stringify(response.data, null, 2));

  const graphResponse = response.data;

  if (!graphResponse) {
    throw new Error('Shopify response missing body');
  }

  if (graphResponse.errors && graphResponse.errors.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(graphResponse.errors)}`);
  }

  if (!graphResponse.data || !graphResponse.data.products) {
    throw new Error(`Unexpected Shopify response shape (products not found). Full response: ${JSON.stringify(graphResponse)}`);
  }

  return graphResponse.data.products;
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Simple background job manager (in-memory)
const jobState = {
  queue: [],
  isProcessing: false,
  lastRunStartedAt: null,
  lastRunFinishedAt: null,
  lastError: null,
  processedProducts: 0,
};

const enqueueUpdateJob = () => {
  jobState.queue.push({ type: 'updateInventoryMetafields', enqueuedAt: Date.now() });
  processJobs();
};

const processJobs = () => {
  if (jobState.isProcessing) return;
  const nextJob = jobState.queue.shift();
  if (!nextJob) return;
  jobState.isProcessing = true;
  jobState.lastRunStartedAt = new Date().toISOString();
  jobState.lastError = null;
  jobState.processedProducts = 0;

  runFullUpdate()
    .then(() => {
      jobState.lastRunFinishedAt = new Date().toISOString();
    })
    .catch((err) => {
      jobState.lastError = err && (err.response ? err.response.data : err.message);
      console.error('Background job failed:', jobState.lastError);
    })
    .finally(() => {
      jobState.isProcessing = false;
      // If more jobs queued while running, process next
      setImmediate(processJobs);
    });
};

// Core logic extracted from the old route and run in background
const runFullUpdate = async () => {
  let hasNextPage = true;
  let endCursor = null;

  while (hasNextPage) {
    const { edges, pageInfo } = await fetchProducts(endCursor);

    for (const product of edges) {
      const productId = product.node.id;
      let warehouseQuantity = 0;
      let vendorQuantity = 0;

      for (const variant of product.node.variants.edges) {
        const inventoryLevels = variant.node.inventoryItem.inventoryLevels.edges;

        for (const inventory of inventoryLevels) {
          const locationName = inventory.node.location.name;
          const quantity = inventory.node.quantities?.[0]?.quantity ?? 0;

          if (locationName === warehouseLocationName) {
            warehouseQuantity += quantity;
          } else if (locationName === vendorLocationName) {
            vendorQuantity += quantity;
          }
        }
      }

      const metafieldsQuery = fetchMetafieldsQuery(productId);
      const metafieldsResponse = await axios({
        method: 'post',
        url: GRAPHQL_URL,
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': ACCESS_TOKEN,
        },
        data: { query: metafieldsQuery },
      });

      const existingMetafields = metafieldsResponse.data.data.product.metafields.edges;
      let currentWarehouseQuantity = 0;
      let currentVendorQuantity = 0;

      for (const metafield of existingMetafields) {
        if (metafield.node.key === warehouseMetafieldKey) {
          currentWarehouseQuantity = parseInt(metafield.node.value, 10);
        } else if (metafield.node.key === vendorMetafieldKey) {
          currentVendorQuantity = parseInt(metafield.node.value, 10);
        }
      }

      if (warehouseQuantity !== currentWarehouseQuantity || vendorQuantity !== currentVendorQuantity) {
        const mutation = updateMetafieldMutation(productId, warehouseQuantity, vendorQuantity);

        await axios({
          method: 'post',
          url: GRAPHQL_URL,
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': ACCESS_TOKEN,
          },
          data: { query: mutation },
        });

        console.log(`Updated product: ${product.node.title} with Warehouse: ${warehouseQuantity}, Vendor: ${vendorQuantity}`);
      } else {
        console.log(`Skipped update for product: ${product.node.title} (no change in quantity)`);
      }

      jobState.processedProducts += 1;
      // Rate limit buffer between each product
      await delay(500);
    }

    hasNextPage = pageInfo.hasNextPage;
    endCursor = pageInfo.endCursor;
  }

  console.log('Metafields updated with inventory quantities.');
};

// New endpoint to trigger the background job without holding the request open
app.get('/update-inventory-metafields', (req, res) => {
  if (jobState.isProcessing) {
    return res.status(202).send('Update already in progress.');
  }
  enqueueUpdateJob();
  return res.status(202).send('Metafields updating process enqueued.');
});

// Lightweight health endpoint for uptime checks
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    processing: jobState.isProcessing,
    queuedJobs: jobState.queue.length,
    lastRunStartedAt: jobState.lastRunStartedAt,
    lastRunFinishedAt: jobState.lastRunFinishedAt,
    lastError: jobState.lastError,
    processedProducts: jobState.processedProducts,
  });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
  } else {
    console.log(`Server is running on port ${PORT}`);
  }
});

// Optional keep-alive pinger to prevent scale-to-zero on some platforms
if (KEEPALIVE_URL) {
  setInterval(async () => {
    try {
      await axios.get(KEEPALIVE_URL, { timeout: 10000 });
      console.log('Keepalive ping sent to', KEEPALIVE_URL);
    } catch (e) {
      console.warn('Keepalive ping failed:', e && (e.response ? e.response.status : e.message));
    }
  }, KEEPALIVE_INTERVAL_MS);
  console.log(`Keepalive pinger enabled. Interval: ${KEEPALIVE_INTERVAL_MS}ms -> ${KEEPALIVE_URL}`);
}
