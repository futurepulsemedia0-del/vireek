import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  computeBounds,
  geofenceCollection,
  isLateJob,
  jobPoint,
  routeCollection,
  trailCollection,
  type MapJob,
  type MapVehicleState,
  type TrailPoint,
  type VehicleView,
} from '@/lib/liveMap';

/** Free, key-less vector style by default; override with VITE_MAP_STYLE_URL (MapTiler, self-hosted, ...). */
const MAP_STYLE = (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || 'https://tiles.openfreemap.org/styles/liberty';

const STATE_COLOR: Record<MapVehicleState, string> = {
  moving: '#16a34a',
  idling: '#d97706',
  stopped: '#2563eb',
  offline: '#94a3b8',
};

interface LiveMapCanvasProps {
  views: VehicleView[];
  jobs: MapJob[];
  trails: Map<string, TrailPoint[]>;
  geofenceM: number;
  nowMs: number;
  selectedId: string | null;
  /** Increment to re-fit the camera around everything currently shown. */
  fitSignal: number;
  onSelectVehicle: (id: string | null) => void;
  onError: (message: string) => void;
}

const EMPTY = { type: 'FeatureCollection', features: [] } as const;

function vehicleElement(): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'flex h-9 w-9 items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-offset-2';
  el.style.transition = 'transform 0.2s';
  return el;
}

function jobElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'h-4 w-4 rotate-45 border-2 border-white shadow-md';
  return el;
}

export function LiveMapCanvas({ views, jobs, trails, geofenceM, nowMs, selectedId, fitSignal, onSelectVehicle, onError }: LiveMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const vehicleMarkers = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLButtonElement }>());
  const jobMarkers = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>());
  const selectRef = useRef(onSelectVehicle);
  selectRef.current = onSelectVehicle;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const latest = useRef({ views, jobs });
  latest.current = { views, jobs };
  const fittedOnce = useRef(false);

  // ---- Create the map once -------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: MAP_STYLE,
        center: [-98.5, 39.8],
        zoom: 3,
        attributionControl: { compact: true },
      });
    } catch {
      errorRef.current('Your browser could not start the map (WebGL may be disabled).');
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      map.addSource('geofences', { type: 'geojson', data: EMPTY as never });
      map.addSource('routes', { type: 'geojson', data: EMPTY as never });
      map.addSource('trails', { type: 'geojson', data: EMPTY as never });
      map.addLayer({ id: 'geofence-fill', type: 'fill', source: 'geofences', paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'geofence-line', type: 'line', source: 'geofences', paint: { 'line-color': '#2563eb', 'line-width': 1.5, 'line-opacity': 0.6 } });
      map.addLayer({
        id: 'trails',
        type: 'line',
        source: 'trails',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['case', ['==', ['get', 'selected'], true], '#2563eb', '#94a3b8'],
          'line-width': ['case', ['==', ['get', 'selected'], true], 4, 2.5],
          'line-opacity': 0.8,
        },
      });
      map.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': '#2563eb', 'line-width': 3, 'line-dasharray': [2, 2] } });
      readyRef.current = true;
      // Trigger the data effects below, which only run once ready.
      map.fire('vireek-ready');
    });

    map.on('click', () => selectRef.current(null));

    map.on('error', (e) => {
      // Before the first load, any error means the style/tiles are unreachable. After it, single tile failures are noise.
      if (!readyRef.current) errorRef.current(e.error?.message || 'The map style could not be loaded.');
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container);

    const vMarkers = vehicleMarkers.current;
    const jMarkers = jobMarkers.current;
    return () => {
      ro.disconnect();
      vMarkers.forEach((m) => m.marker.remove());
      jMarkers.forEach((m) => m.marker.remove());
      vMarkers.clear();
      jMarkers.clear();
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- Push data whenever it changes (and once the style is ready) --------
  const visibleIds = useMemo(() => new Set(views.map((v) => v.id)), [views]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      (map.getSource('geofences') as maplibregl.GeoJSONSource | undefined)?.setData(geofenceCollection(jobs, geofenceM) as never);
      (map.getSource('routes') as maplibregl.GeoJSONSource | undefined)?.setData(routeCollection(views) as never);
      (map.getSource('trails') as maplibregl.GeoJSONSource | undefined)?.setData(trailCollection(trails, visibleIds, selectedId) as never);
    };
    if (readyRef.current) apply();
    else map.once('vireek-ready' as never, apply);
  }, [views, jobs, trails, geofenceM, visibleIds, selectedId]);

  // ---- Vehicle markers (realtime: moved in place, never recreated) --------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const seen = new Set<string>();
      for (const v of latest.current.views) {
        seen.add(v.id);
        let entry = vehicleMarkers.current.get(v.id);
        if (!entry) {
          const el = vehicleElement();
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            selectRef.current(v.id);
          });
          const marker = new maplibregl.Marker({ element: el }).setLngLat([v.point.lng, v.point.lat]).addTo(map);
          entry = { marker, el };
          vehicleMarkers.current.set(v.id, entry);
        }
        entry.marker.setLngLat([v.point.lng, v.point.lat]);
        entry.el.style.backgroundColor = STATE_COLOR[v.state];
        entry.el.style.zIndex = v.id === selectedId ? '3' : '2';
        entry.el.style.transform = v.id === selectedId ? 'scale(1.25)' : 'scale(1)';
        entry.el.textContent = (v.techName ?? v.label).trim().slice(0, 2).toUpperCase();
        entry.el.setAttribute('aria-label', `${v.label}${v.techName ? `, ${v.techName}` : ''}, ${v.state}`);
      }
      for (const [id, entry] of vehicleMarkers.current) {
        if (!seen.has(id)) {
          entry.marker.remove();
          vehicleMarkers.current.delete(id);
        }
      }
    };
    if (readyRef.current) apply();
    else map.once('vireek-ready' as never, apply);
  }, [views, selectedId]);

  // ---- Job markers ----------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const seen = new Set<string>();
      for (const job of latest.current.jobs) {
        const p = jobPoint(job);
        if (!p) continue;
        seen.add(job.id);
        let entry = jobMarkers.current.get(job.id);
        if (!entry) {
          const el = jobElement();
          const marker = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
          entry = { marker, el };
          jobMarkers.current.set(job.id, entry);
        }
        entry.marker.setLngLat([p.lng, p.lat]);
        const late = isLateJob(job, nowMs);
        entry.el.style.backgroundColor = late ? '#dc2626' : job.job_status === 'scheduled' ? '#f8fafc' : '#2563eb';
        entry.el.style.borderColor = late ? '#ffffff' : '#2563eb';
        entry.el.title = `${job.customer_name}${job.service_type ? ` — ${job.service_type}` : ''}${late ? ' (late)' : ''}`;
      }
      for (const [id, entry] of jobMarkers.current) {
        if (!seen.has(id)) {
          entry.marker.remove();
          jobMarkers.current.delete(id);
        }
      }
    };
    if (readyRef.current) apply();
    else map.once('vireek-ready' as never, apply);
  }, [jobs, nowMs]);

  // ---- Camera ---------------------------------------------------------------
  const fit = () => {
    const map = mapRef.current;
    if (!map) return;
    const pts = [
      ...latest.current.views.map((v) => v.point),
      ...latest.current.jobs.map(jobPoint).filter((p): p is NonNullable<typeof p> => p !== null),
    ];
    const bounds = computeBounds(pts);
    if (!bounds) return;
    if (bounds[0][0] === bounds[1][0] && bounds[0][1] === bounds[1][1]) map.flyTo({ center: bounds[0], zoom: 14 });
    else map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 600 });
  };

  useEffect(() => {
    // First time data shows up, frame it; afterwards only on explicit request.
    if (!fittedOnce.current && (views.length > 0 || jobs.length > 0)) {
      fittedOnce.current = true;
      fit();
    }
  }, [views.length, jobs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fitSignal > 0) fit();
  }, [fitSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    const v = views.find((x) => x.id === selectedId);
    if (map && v) map.flyTo({ center: [v.point.lng, v.point.lat], zoom: Math.max(map.getZoom(), 14), duration: 600 });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="h-full w-full" role="application" aria-label="Live fleet map" />;
}
