import { Router, Request, Response } from 'express';
import { matchAndProcessDeposit } from '../services/paymentProcessor';
import type { MuralTransaction } from '../services/muralPay';

const router = Router();

/**
 * POST /webhooks/mural
 *
 * Receives webhook events from Mural Pay.
 * Subscribed to: MURAL_ACCOUNT_BALANCE_ACTIVITY
 *
 * Mural sends events with a signature header (X-Mural-Signature) using ECDSA.
 * For simplicity we do not verify the signature here — see README for production notes.
 */
router.post('/mural', async (req: Request, res: Response) => {
  try {
    const event = req.body as {
      eventCategory?: string;
      payload?: unknown;
    };

    console.log('[Webhook] Received event:', JSON.stringify(event).slice(0, 200));

    // Respond immediately to acknowledge receipt
    res.status(200).json({ received: true });

    // Process asynchronously
    handleWebhookEvent(event as { eventCategory?: string; payload?: unknown }).catch((err) => {
      console.error('[Webhook] Handler error:', err);
    });
  } catch (err) {
    console.error('[Webhook] POST /mural error:', err);
    res.status(500).json({ error: 'Webhook processing error' });
  }
});

/**
 * Processes a Mural webhook event after the HTTP response has already been sent.
 * MURAL_ACCOUNT_BALANCE_ACTIVITY events carry a transaction object that gets passed
 * to matchAndProcessDeposit(). PAYOUT_REQUEST events are ignored here since payout
 * status is handled by the periodic sync job.
 */
async function handleWebhookEvent(event: { eventCategory?: string; payload?: unknown }): Promise<void> {
  const category = event.eventCategory;

  if (category === 'MURAL_ACCOUNT_BALANCE_ACTIVITY') {
    // The payload contains a Transaction object
    const tx = event.payload as MuralTransaction;
    if (tx) {
      console.log(`[Webhook] Balance activity — tx ${tx.id}, type ${(tx.transactionDetails as { type: string })?.type}, amount ${tx.amount?.tokenAmount} ${tx.amount?.tokenSymbol}`);
      await matchAndProcessDeposit(tx);
    }
  } else if (category === 'PAYOUT_REQUEST') {
    console.log('[Webhook] Payout request event received (handled by status sync job)');
  } else {
    console.log(`[Webhook] Unhandled event category: ${category}`);
  }
}

export default router;
