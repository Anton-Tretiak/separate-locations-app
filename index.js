require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const SHOP = process.env.SHOP;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const GRAPHQL_URL = `https://${SHOP}/admin/api/2023-07/graphql.json`;
const PORT = process.env.PORT || 3340;

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
                          available
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

  return response.data.data.products;
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get('/update-inventory-metafields', (req, res) => {
  res.send('Metafields updating process started...');

  setImmediate(async () => {
    try {
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
              const quantity = inventory.node.available;

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
            // Update the metafields with the quantities if they differ
            const mutation = updateMetafieldMutation(productId, warehouseQuantity, vendorQuantity);

            const metafieldResponse = await axios({
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

          // Add delay between each product's API call to avoid Shopify rate limit
          await delay(500); // 500ms delay between each product mutation/fetch
        }

        hasNextPage = pageInfo.hasNextPage;
        endCursor = pageInfo.endCursor;
      }

      console.log('Metafields updated with inventory quantities.');
    } catch (error) {
      console.error(error.response ? error.response.data : error.message);
    }
  });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
  } else {
    console.log(`Server is running on port ${PORT}`);
  }
});
