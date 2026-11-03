import { Router, Request, Response } from 'express';
import { PC_COMPONENTS } from '../data/pcComponents';

const router = Router();

/**
 * GET /api/hardware/components
 * Returns structured catalog of hardware components
 */
router.get('/components', (_req: Request, res: Response) => {
  res.json({
    success: true,
    components: PC_COMPONENTS
  });
});

export default router;
