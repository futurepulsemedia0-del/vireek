import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { circleRing, computeBounds, metersBetween } from '@/lib/liveMap';
import {
  MAX_VERTICES, clampRadiusM, draftCollection, radiusHandlePoint, removeVertex, zoneCollection,
  type Geofence, type GeofenceDraft, type LngLat,
} from '@/lib/geofences';

interface GeofenceMapLayerProps {
  /** The live MapLibre instance (from LiveMapCanvas.onMapReady); null until the style has loaded. */
  map: maplibregl.Map | null;
  zones: Geofence[];
  selectedZoneId: string | null;
  /** The zone being created / edited. Its saved copy (if any) is hidden while the draft is shown. */
  draft: GeofenceDraft | null;
  /** True while clicks on the map place points (circle center / polygon vertices). */
  drawing: boolean;
  onSelectZone: (id: string | null) => void;
  onDraftChange: (next: GeofenceDraft) => void;
  /** The user closed the shape (clicked the first point, or placed the circle center). */
  onDrawDone: () => void;
}

const SOURCES = ['zones', 'zone-draft'] as const;
const LAYERS = ['zones-fill', 'zones-line', 'zone-draft-fill', 'zone-draft-line'] as const;
const EMPTY = { type: 'FeatureCollection', features: [] } as const;

type HandleKind = 'vertex' | 'first' | 'center' | 'radius';

function handleElement(kind: HandleKind, color: string, label: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.setAttribute('aria-label', label);
  el.title = label;
  const size = kind === 'first' ? 20 : kind === 'center' ? 22 : 16;
  el.className = 'focus-ring border-2 border-white shadow-lg';
  el.style.cssText = `width:${size}px;height:${size}px;background:${kind === 'radius' ? '#ffffff' : color};border-color:${kind === 'radius' ? color : '#ffffff'};border-radius:${kind === 'radius' ? '4px' : '50%'};cursor:grab;touch-action:none;padding:0;z-index:5`;
  return el;
}

export function zoneBounds(z: Pick<Geofence, 'shape' | 'lat' | 'lng' | 'radiusM' | 'polygon'>): [[number, number], [number, number]] | null {
  const pts = z.shape === 'polygon' && z.polygon ? z.polygon : circleRing({ lat: z.lat, lng: z.lng }, z.radiusM);
  return computeBounds(pts.map(([lng, lat]) => ({ lat, lng })));
}

export function GeofenceMapLayer({ map, zones, selectedZoneId, draft, drawing, onSelectZone, onDraftChange, onDrawDone }: GeofenceMapLayerProps) {
  const latest = useRef({ draft, drawing, zones, onSelectZone, onDraftChange, onDrawDone });
  latest.current = { draft, drawing, zones, onSelectZone, onDraftChange, onDrawDone };
  const markers = useRef<Array<{ marker: maplibregl.Marker; kind: HandleKind; index: number }>>([]);
  const dragging = useRef(false);
  const justDragged = useRef(false);

  // ---- Sources + layers (once per map) ------------------------------------
  useEffect(() => {
    if (!map) return;
    try {
      if (!map.getSource('zones')) {
        map.addSource('zones', { type: 'geojson', data: EMPTY as never });
        map.addSource('zone-draft', { type: 'geojson', data: EMPTY as never });
        map.addLayer({
          id: 'zones-fill', type: 'fill', source: 'zones',
          paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'selected'], true], 0.3, ['==', ['get', 'active'], false], 0.04, 0.14] },
        });
        map.addLayer({
          id: 'zones-line', type: 'line', source: 'zones',
          paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'selected'], true], 3, 1.75], 'line-opacity': ['case', ['==', ['get', 'active'], false], 0.45, 0.9] },
        });
        map.addLayer({ id: 'zone-draft-fill', type: 'fill', source: 'zone-draft', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
        map.addLayer({ id: 'zone-draft-line', type: 'line', source: 'zone-draft', paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [2, 1.5] } });
      }
    } catch {
      /* style not ready */
    }
    return () => {
      try {
        LAYERS.forEach((id) => map.getLayer(id) && map.removeLayer(id));
        SOURCES.forEach((id) => map.getSource(id) && map.removeSource(id));
      } catch {
        /* the map was already destroyed */
      }
    };
  }, [map]);

  // ---- Push data ---------------------------------------------------------------
  useEffect(() => {
    if (!map) return;
    try {
      (map.getSource('zones') as maplibregl.GeoJSONSource | undefined)?.setData(zoneCollection(zones, selectedZoneId, draft?.id ?? null) as never);
      (map.getSource('zone-draft') as maplibregl.GeoJSONSource | undefined)?.setData(draftCollection(draft) as never);
    } catch {
      /* destroyed mid-update */
    }
  }, [map, zones, selectedZoneId, draft]);

  // ---- Select a saved zone by clicking it; hover shows its name ------------------
  useEffect(() => {
    if (!map) return;
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (latest.current.drawing || latest.current.draft) return;
      const id = e.features?.[0]?.properties?.id;
      if (typeof id === 'string') latest.current.onSelectZone(id);
    };
    const onMove = (e: maplibregl.MapLayerMouseEvent) => {
      if (latest.current.drawing) return;
      map.getCanvas().style.cursor = 'pointer';
      const name = e.features?.[0]?.properties?.name;
      if (typeof name === 'string') popup.setLngLat(e.lngLat).setText(name).addTo(map);
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = latest.current.drawing ? 'crosshair' : '';
      popup.remove();
    };
    map.on('click', 'zones-fill', onClick);
    map.on('mousemove', 'zones-fill', onMove);
    map.on('mouseleave', 'zones-fill', onLeave);
    return () => {
      popup.remove();
      try {
        map.off('click', 'zones-fill', onClick);
        map.off('mousemove', 'zones-fill', onMove);
        map.off('mouseleave', 'zones-fill', onLeave);
      } catch {
        /* destroyed */
      }
    };
  }, [map]);

  // ---- Drawing: clicks place points ----------------------------------------------
  useEffect(() => {
    if (!map || !drawing) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
    const onClick = (e: maplibregl.MapMouseEvent) => {
      const { draft: d, onDraftChange: change, onDrawDone: done } = latest.current;
      if (!d) return;
      const point: LngLat = [e.lngLat.lng, e.lngLat.lat];
      if (d.shape === 'circle') {
        change({ ...d, center: { lat: point[1], lng: point[0] } });
        done();
      } else if (d.polygon.length < MAX_VERTICES) {
        change({ ...d, polygon: [...d.polygon, point] });
      }
    };
    map.on('click', onClick);
    return () => {
      try {
        map.off('click', onClick);
        canvas.style.cursor = '';
        map.doubleClickZoom.enable();
      } catch {
        /* destroyed */
      }
    };
  }, [map, drawing]);

  // ---- Draggable handles (rebuilt only when the shape's structure changes) -------
  const structure = draft ? `${draft.shape}:${draft.polygon.length}:${draft.center ? 1 : 0}:${drawing ? 1 : 0}` : 'none';

  useEffect(() => {
    if (!map || !draft) return;
    const clear = () => {
      markers.current.forEach((m) => m.marker.remove());
      markers.current = [];
    };
    clear();

    const add = (kind: HandleKind, index: number, pos: LngLat, label: string) => {
      const el = handleElement(kind, draft.color, label);
      const marker = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(pos).addTo(map);
      const removePoint = () => {
        const d = latest.current.draft;
        if (!d || d.shape !== 'polygon' || d.polygon.length <= 3) return;
        latest.current.onDraftChange({ ...d, polygon: removeVertex(d.polygon, index) });
      };
      el.addEventListener('click', (ev) => {
        ev.stopPropagation(); // never let a handle click place a new point
        const cur = latest.current;
        if (!justDragged.current && kind === 'first' && cur.drawing && cur.draft && cur.draft.polygon.length >= 3) cur.onDrawDone();
      });
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (kind === 'vertex' || kind === 'first') removePoint();
      });
      el.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && (kind === 'vertex' || kind === 'first')) {
          ev.preventDefault();
          removePoint();
        }
      });
      marker.on('dragstart', () => {
        dragging.current = true;
      });
      marker.on('drag', () => {
        const d = latest.current.draft;
        if (!d) return;
        const ll = marker.getLngLat();
        if (kind === 'vertex' || kind === 'first') {
          latest.current.onDraftChange({ ...d, polygon: d.polygon.map((p, i) => (i === index ? ([ll.lng, ll.lat] as LngLat) : p)) });
        } else if (kind === 'center') {
          latest.current.onDraftChange({ ...d, center: { lat: ll.lat, lng: ll.lng } });
        } else if (d.center) {
          latest.current.onDraftChange({ ...d, radiusM: clampRadiusM(metersBetween(d.center, { lat: ll.lat, lng: ll.lng })) });
        }
      });
      marker.on('dragend', () => {
        dragging.current = false;
        justDragged.current = true;
        window.setTimeout(() => { justDragged.current = false; }, 0);
        const d = latest.current.draft;
        if (kind === 'radius' && d?.center) marker.setLngLat(radiusHandlePoint(d.center, d.radiusM)); // snap back to the edge
      });
      markers.current.push({ marker, kind, index });
    };

    if (draft.shape === 'polygon') {
      draft.polygon.forEach((p, i) =>
        add(i === 0 ? 'first' : 'vertex', i, p, i === 0 ? 'First point (click to close the shape)' : `Point ${i + 1}. Drag to move, right-click or press Delete to remove`),
      );
    } else if (draft.center) {
      add('center', 0, [draft.center.lng, draft.center.lat], 'Zone center. Drag to move');
      add('radius', 0, radiusHandlePoint(draft.center, draft.radiusM), 'Radius handle. Drag to resize');
    }
    return clear;
    // Rebuilt on structure changes only; positions are synced by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, structure]);

  // ---- Keep handle positions in sync with the draft (skipped mid-drag) ------------
  useEffect(() => {
    if (!draft || dragging.current) return;
    for (const { marker, kind, index } of markers.current) {
      if (kind === 'vertex' || kind === 'first') {
        const p = draft.polygon[index];
        if (p) marker.setLngLat(p);
      } else if (draft.center) {
        marker.setLngLat(kind === 'center' ? [draft.center.lng, draft.center.lat] : radiusHandlePoint(draft.center, draft.radiusM));
      }
    }
  }, [draft]);

  // ---- Frame a zone when it is selected or opened for editing --------------------
  const framedId = draft?.id ?? selectedZoneId;
  useEffect(() => {
    if (!map || !framedId) return;
    const zone = latest.current.zones.find((z) => z.id === framedId);
    const bounds = zone ? zoneBounds(zone) : null;
    if (bounds) map.fitBounds(bounds, { padding: 80, maxZoom: 17, duration: 500 });
  }, [map, framedId]);

  return null;
}
