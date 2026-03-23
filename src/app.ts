import express from 'express';
import productsRouter from './routes/products';
import ordersRouter from './routes/orders';
import merchantRouter from './routes/merchant';
import webhooksRouter from './routes/webhooks';

const app = express();

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/products', productsRouter);
app.use('/orders', ordersRouter);
app.use('/merchant', merchantRouter);
app.use('/webhooks', webhooksRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export default app;
