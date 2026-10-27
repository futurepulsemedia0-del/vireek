import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { computeBounds, doorsToGeoJSON, hasPoint, NEW_DOOR_COLOR, OUTCOMES, STATUS_ORDER, type Door, type DoorStatus } from '@/lib/canvassing';

/** Free, key-less vector style by default; override with VITE_MAP_STYLE_URL (same switch as the Live Map). */
const MAP_STYLE = (import.meta.env.VITE_MAP_STYLE_URL as string | undefined) || 'https://tiles.openfreemap.org/styles/liberty';

const colorExpression = ['match', ['get', 'status'], ...STATUS_ORDER.flatMap((s) => [s, s === 'new' ? NEW_DOOR_COLOR : OUTCOMES[s as Exclude<DoorStatus, 'new'>].color]), NEW_DOOR_COLOR];

export interface CanvassMapProps {
  doors: Door[];
  selectedId: string | null;
  /** Increment to re-fit the camera around everything currently shown. */
  fitSignal: number;
  /** While true a tap on the map picks a point instead of selecting a door. */
  pickMode: boolean;
  pickedPoint: { lat: number; lng: number } | null;
  onSelect: (id: string | null) => void;
  onPick: (point: { lat: number; lng: number }) => void;
  onLocate: (point: { lat: number; lng: number }) => void;
  onError: (message: string) => void;
}

function fitTo(map: maplibregl.Map, points: { lat: number; lng: number }[]) {
  const bounds = computeBounds(points);
  if (!bounds) return;
  if (points.length === 1) map.easeTo({ center: bounds[0], zoom: 16, duration: 0 });
  else map.fitBounds(bounds, { padding: 48, maxZoom: 17, duration: 0 });
}

export default function CanvassMap({ doors, selectedId, fitSignal, pickMode, pickedPoint, onSelect, onPick, onLocate, onError }: CanvassMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const pickMarkerRef = useRef<maplibregl.Marker | null>(null);

  const geojson = useMemo(() => doorsToGeoJSON(doors), [doors]);
  const points = useMemo(() => doors.filter(hasPoint), [doors]);

  // Latest props for the long-lived map handlers (the map is created once).
  const latest = useRef({ geojson, points, selectedId, pickMode, onSelect, onPick, onLocate, onError });
  latest.current = { geojson, points, selectedId, pickMode, onSelect, onPick, onLocate, onError };

  // ---- Create the map once -------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({ container, style: MAP_STYLE, center: [-98.5, 39.8], zoom: 3, attributionControl: { compact: true } });
    } catch {
      latest.current.onError('Your browser could not start the map (WebGL may be disabled).');
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false, showUserLocation: true });
    geolocate.on('geolocate', (e: unknown) => {
      const c = (e as { coords?: { latitude: number; longitude: number } }).coords;
      if (c) latest.current.onLocate({ lat: c.latitude, lng: c.longitude });
    });
    map.addControl(geolocate, 'top-right');

    map.on('load', () => {
      map.addSource('doors', { type: 'geojson', data: latest.current.geojson as never, cluster: true, clusterRadius: 44, clusterMaxZoom: 15 });
      map.addLayer({
        id: 'door-clusters', type: 'circle', source: 'doors', filter: ['has', 'point_count'],
        paint: { 'circle-color': '#2563eb', 'circle-opacity': 0.85, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-radius': ['step', ['get', 'point_count'], 16, 25, 20, 100, 26] },
      } as never);
      map.addLayer({
        id: 'door-cluster-count', type: 'symbol', source: 'doors', filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] },
        paint: { 'text-color': '#ffffff' },
      } as never);
      map.addLayer({
        id: 'door-points', type: 'circle', source: 'doors', filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': colorExpression,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 8, 18, 11],
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
        },
      } as never);
      map.addLayer({
        id: 'door-selected', type: 'circle', source: 'doors', filter: ['==', ['get', 'id'], latest.current.selectedId ?? ''],
        paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 15, 'circle-stroke-color': '#111827', 'circle-stroke-width': 3 },
      } as never);
      readyRef.current = true;
      fitTo(map, latest.current.points);
    });

    map.on('click', 'door-points', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === 'string' && !latest.current.pickMode) latest.current.onSelect(id);
    });
    map.on('click', 'door-clusters', (e) => {
      const f = e.features?.[0];
      const clusterId = f?.properties?.cluster_id;
      const src = map.getSource('doors') as maplibregl.GeoJSONSource | undefined;
      if (!f || typeof clusterId !== 'number' || !src) return;
      void src.getClusterExpansionZoom(clusterId).then((zoom) => {
        map.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom: zoom + 0.5 });
      }).catch(() => undefined);
    });
    map.on('click', (e) => {
      if (latest.current.pickMode) {
        latest.current.onPick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
        return;
      }
      const hit = map.queryRenderedFeatures(e.point, { layers: ['door-points', 'door-clusters'] });
      if (hit.length === 0) latest.current.onSelect(null);
    });
    map.on('mouseenter', 'door-points', () => { if (!latest.current.pickMode) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'door-points', () => { map.getCanvas().style.cursor = latest.current.pickMode ? 'crosshair' : ''; });
    map.on('error', (e) => {
      // Before the first load any error means the style / tiles are unreachable; later single-tile failures are noise.
      if (!readyRef.current) latest.current.onError(e.error?.message || 'The map style could not be loaded.');
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container);
    return () => {
      ro.disconnect();
      pickMarkerRef.current?.remove();
      pickMarkerRef.current = null;
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- Data -------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource('doors') as maplibregl.GeoJSONSource | undefined)?.setData(geojson as never);
  }, [geojson]);

  // ---- Selection ring -------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getLayer('door-selected')) return;
    map.setFilter('door-selected', ['==', ['get', 'id'], selectedId ?? ''] as never);
    const d = selectedId ? points.find((p) => p.id === selectedId) : undefined;
    if (d && hasPoint(d)) {
      const bounds = map.getBounds();
      if (!bounds.contains([d.lng, d.lat])) map.easeTo({ center: [d.lng, d.lat], duration: 300 });
    }
    // `points` only supplies the coordinates of the selected door; re-running on every refresh would fight the user's panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ---- Fit camera -------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map && readyRef.current) fitTo(map, latest.current.points);
  }, [fitSignal]);

  // ---- Pick mode ------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = pickMode ? 'crosshair' : '';
  }, [pickMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pickMarkerRef.current?.remove();
    pickMarkerRef.current = null;
    if (pickedPoint) {
      pickMarkerRef.current = new maplibregl.Marker({ color: '#111827' }).setLngLat([pickedPoint.lng, pickedPoint.lat]).addTo(map);
    }
  }, [pickedPoint]);

  return <div ref={containerRef} role="application" aria-label="Door map" className="h-full w-full" />;
}
