import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchPublicArPreviews: vi.fn(),
  trackArEvent: vi.fn(),
}));
vi.mock('@/lib/quoteArApi', () => api);
vi.mock('@/lib/loadModelViewer', () => ({ loadModelViewer: () => Promise.resolve() }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,AAAA') } }));

import { QuoteArSection } from '@/components/quotes/QuoteArSection';

const preview = {
  id: '5b4d0c20-3e6f-4081-8cbd-2e3f4a5b6c7d',
  option_id: null,
  name: 'Carrier Infinity 96 Furnace',
  brand: 'Carrier',
  model_number: '59TN6',
  category: 'furnace',
  placement: 'floor',
  width_mm: 610,
  depth_mm: 711,
  height_mm: 1372,
  clearance_mm: 762,
  glb_url: 'https://example.test/furnace.glb?token=abc',
  usdz_url: null,
};

function stubViewer(el: HTMLElement, opts: { canActivateAR: boolean }) {
  const activateAR = vi.fn();
  Object.assign(el, {
    canActivateAR: opts.canActivateAR,
    activateAR,
    getDimensions: () => ({ x: 0.61, y: 1.372, z: 0.711 }),
  });
  return activateAR;
}

async function openPreview() {
  fireEvent.click(await screen.findByRole('button', { name: /preview in 3d/i }));
  return waitFor(() => {
    const el = document.querySelector('model-viewer');
    expect(el).not.toBeNull();
    return el as HTMLElement;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchPublicArPreviews.mockResolvedValue({ previews: [preview], quoteStatus: 'sent' });
});

describe('QuoteArSection', () => {
  it('renders nothing when there are no previews', async () => {
    api.fetchPublicArPreviews.mockResolvedValue({ previews: [], quoteStatus: 'sent' });
    const { container } = render(<QuoteArSection token="t" quoteOpen />);
    await waitFor(() => expect(api.fetchPublicArPreviews).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing (and never throws) when loading fails', async () => {
    api.fetchPublicArPreviews.mockResolvedValue(null);
    const { container } = render(<QuoteArSection token="t" quoteOpen />);
    await waitFor(() => expect(api.fetchPublicArPreviews).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('hides itself once the quote has been answered', async () => {
    const { container } = render(<QuoteArSection token="t" quoteOpen={false} />);
    await waitFor(() => expect(api.fetchPublicArPreviews).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the equipment with real dimensions and switches units', async () => {
    render(<QuoteArSection token="t" quoteOpen />);
    expect(await screen.findByText('Carrier Infinity 96 Furnace')).toBeInTheDocument();
    expect(screen.getByText(/W 24 in × D 28 in × H 54 in/)).toBeInTheDocument();
    expect(screen.getByText(/allow 30 in clear in front/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'cm' }));
    expect(screen.getByText(/W 61 cm × D 71.1 cm × H 137.2 cm/)).toBeInTheDocument();
  });

  it('opens the viewer at TRUE SIZE, tracks the view, and launches AR on tap', async () => {
    render(<QuoteArSection token="tok" quoteOpen />);
    const el = await openPreview();

    expect(api.trackArEvent).toHaveBeenCalledWith('tok', preview.id, 'viewed', expect.any(String));
    expect(el.getAttribute('src')).toBe(preview.glb_url);
    expect(el.getAttribute('ar-scale')).toBe('fixed'); // customers must not be able to resize the unit
    expect(el.getAttribute('ar-placement')).toBe('floor');
    expect(el.getAttribute('ar-modes')).toContain('quick-look');

    const activateAR = stubViewer(el, { canActivateAR: true });
    fireEvent(el, new Event('load'));

    const launch = await screen.findByRole('button', { name: /view in your space/i });
    fireEvent.click(launch);
    expect(activateAR).toHaveBeenCalledTimes(1);
    expect(api.trackArEvent).toHaveBeenCalledWith('tok', preview.id, 'ar_launched', expect.any(String));
  });

  it('falls back gracefully (QR / message) when the device cannot do AR', async () => {
    render(<QuoteArSection token="tok" quoteOpen />);
    const el = await openPreview();
    stubViewer(el, { canActivateAR: false });
    fireEvent(el, new Event('load'));

    expect(await screen.findByText(/AR works on phones and tablets|can.t place objects in AR/i, {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /view in your space/i })).not.toBeInTheDocument());
    await waitFor(
      () => expect(api.trackArEvent).toHaveBeenCalledWith('tok', preview.id, 'ar_unsupported', expect.any(String)),
      { timeout: 3000 },
    );
  });

  it('shows a retry state when the model fails to load and refreshes the links', async () => {
    render(<QuoteArSection token="tok" quoteOpen />);
    const el = await openPreview();
    fireEvent(el, new Event('error'));

    const retry = await screen.findByRole('button', { name: /try again/i });
    api.fetchPublicArPreviews.mockClear();
    fireEvent.click(retry);
    await waitFor(() => expect(api.fetchPublicArPreviews).toHaveBeenCalledWith('tok'));
  });
});
