import { describe, expect, it, vi } from 'vitest';
import { fetchHeatReading, type FetchFn } from './heatWeather';

const NOW = new Date('2030-07-10T15:20:00.000Z');
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function router(over: Partial<Record<'zip' | 'points' | 'hourly', () => Response | Promise<Response>>> = {}): FetchFn {
  return async (url: string) => {
    if (url.includes('zippopotam')) return (over.zip ?? (() => ok({ places: [{ latitude: '30.27', longitude: '-97.74' }] })))();
    if (url.includes('/points/')) return (over.points ?? (() => ok({ properties: { forecastHourly: 'https://api.weather.gov/gridpoints/EWX/1,1/forecast/hourly' } })))();
    return (over.hourly ?? (() => ok({
      properties: { periods: [
        { startTime: '2030-07-10T14:00:00Z', endTime: '2030-07-10T15:00:00Z', temperature: 90, temperatureUnit: 'F', relativeHumidity: { value: 50 } },
        { startTime: '2030-07-10T15:00:00Z', endTime: '2030-07-10T16:00:00Z', temperature: 96, temperatureUnit: 'F', relativeHumidity: { value: 60 } },
      ] },
    })))();
  };
}

describe('fetchHeatReading', () => {
  it('returns the forecast hour that contains now', async () => {
    const r = await fetchHeatReading('78701', router(), NOW);
    expect(r).toMatchObject({ ok: true, reading: { tempF: 96, rhPct: 60, source: 'nws_hourly_forecast' } });
    if (r.ok) expect(r.reading.observedAt.toISOString()).toBe('2030-07-10T15:00:00.000Z');
  });

  it('converts Celsius periods to Fahrenheit', async () => {
    const f = router({ hourly: () => ok({ properties: { periods: [{ startTime: '2030-07-10T15:00:00Z', endTime: '2030-07-10T16:00:00Z', temperature: 35, temperatureUnit: 'C', relativeHumidity: { value: 40 } }] } }) });
    const r = await fetchHeatReading('78701', f, NOW);
    expect(r.ok && Math.round(r.reading.tempF)).toBe(95);
  });

  it('rejects a bad ZIP without any network call', async () => {
    const spy = vi.fn();
    expect(await fetchHeatReading('7870', spy as unknown as FetchFn, NOW)).toEqual({ ok: false, error: 'bad_zip' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports each failure stage distinctly', async () => {
    expect(await fetchHeatReading('78701', router({ zip: () => new Response('', { status: 404 }) }), NOW)).toEqual({ ok: false, error: 'geocode_failed' });
    expect(await fetchHeatReading('78701', router({ points: () => new Response('', { status: 500 }) }), NOW)).toEqual({ ok: false, error: 'points_failed' });
    expect(await fetchHeatReading('78701', router({ hourly: () => new Response('', { status: 503 }) }), NOW)).toEqual({ ok: false, error: 'forecast_failed' });
  });

  it('refuses to follow a forecast link that leaves api.weather.gov', async () => {
    const f = router({ points: () => ok({ properties: { forecastHourly: 'https://evil.example/hourly' } }) });
    expect(await fetchHeatReading('78701', f, NOW)).toEqual({ ok: false, error: 'points_failed' });
  });

  it('never invents humidity', async () => {
    const f = router({ hourly: () => ok({ properties: { periods: [{ startTime: '2030-07-10T15:00:00Z', endTime: '2030-07-10T16:00:00Z', temperature: 96, temperatureUnit: 'F' }] } }) });
    expect(await fetchHeatReading('78701', f, NOW)).toEqual({ ok: false, error: 'no_humidity' });
  });

  it('maps a timeout to its own error', async () => {
    const f: FetchFn = async () => { throw new DOMException('timed out', 'TimeoutError'); };
    expect(await fetchHeatReading('78701', f, NOW)).toEqual({ ok: false, error: 'timeout' });
  });
});
