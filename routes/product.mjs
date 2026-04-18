import express from 'express';
import { validate } from '../middleware/validate.mjs';
import {
    createProductSchema,
    updateProductSchema,
    updateStockSchema,
    bulkUpdateStockSchema,
} from '../middleware/validationSchemas.mjs';

import {
    createProduct,
    getAllProducts,
    getProduct,
    getProductByBarcode,
    getProductBySku,
    updateProduct,
    deleteProduct,
    updateStock,
    bulkUpdateStock,
    getCategories,
    getLowStockProducts,
    generateBarcode,
    generateSku,
    getStockMovements,
    getInventoryValuation,
    getDeadStock,
    getStockReport
} from '../controllers/product.mjs';

const productRouter = express.Router();

productRouter
    .post('/', validate(createProductSchema), createProduct)
    .get('/', getAllProducts)
    .get('/categories', getCategories)
    .get('/low-stock', getLowStockProducts)
    .get('/stock-movements', getStockMovements)
    .get('/report/valuation', getInventoryValuation)
    .get('/report/dead-stock', getDeadStock)
    .get('/report/stock', getStockReport)
    .get('/generate-barcode', generateBarcode)
    .get('/generate-sku', generateSku)
    .get('/barcode/:barcode', getProductByBarcode)
    .get('/sku/:sku', getProductBySku)
    .post('/bulk-stock', validate(bulkUpdateStockSchema), bulkUpdateStock)
    .get('/:id', getProduct)
    .patch('/:id', validate(updateProductSchema), updateProduct)
    .patch('/:id/stock', validate(updateStockSchema), updateStock)
    .delete('/:id', deleteProduct);

export default productRouter;
