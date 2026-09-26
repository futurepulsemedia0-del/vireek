import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  X,
  Check,
  MapPin,
  DoorOpen,
  Layers,
  ArrowLeft,
  Wrench,
  Star,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, Customer, Equipment, Job } from '@/lib/supabase';
import {
  SiteType,
  RoomType,
  SITE_TYPE_LABELS,
  SITE_TYPE_OPTIONS,
  ROOM_TYPE_LABELS,
  ROOM_TYPE_OPTIONS,
  HierarchySite,
  flattenRoomsForPicker,
  formatSiteLocationLine,
  totalRoomCount,
  totalAssignedAssetCount,
} from '@/lib/siteHierarchy';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

const labelClass = 'mb-1.5 block text-xs font-medium text-text-secondary';

const smallBtn =
  'focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-accent transition-colors';

type DeleteTarget = { level: 'site' | 'building' | 'floor' | 'room'; id: string; label: string } | null;

// ============================================================
// PAGE
// ============================================================

export function CustomerSitesPage() {
  const { id: customerId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [sites, setSites] = useState<HierarchySite[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [jobs, setJobs] = useState<Pick<Job, 'id' | 'customer_name' | 'service_type' | 'job_status' | 'scheduled_datetime' | 'site_id'>[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);

  const [showAddSite, setShowAddSite] = useState(false);
  const [siteDraft, setSiteDraft] = useState({ name: '', site_type: 'other' as SiteType, address: '', is_primary: false });

  const [addingBuildingFor, setAddingBuildingFor] = useState<string | null>(null);
  const [buildingName, setBuildingName] = useState('');

  const [addingFloorFor, setAddingFloorFor] = useState<string | null>(null);
  const [floorName, setFloorName] = useState('');

  const [addingRoomFor, setAddingRoomFor] = useState<string | null>(null);
  const [roomDraft, setRoomDraft] = useState({ name: '', room_type: 'other' as RoomType });

  const loadAll = useCallback(async () => {
    if (!user || !customerId) return;
    setLoading(true);
    const [customerRes, hierarchyRes, equipmentRes, jobsRes] = await Promise.all([
      supabase.from('customers').select('*').eq('id', customerId).maybeSingle(),
      supabase.rpc('get_customer_site_hierarchy', { p_customer_id: customerId }),
      supabase.from('equipment').select('*').eq('customer_id', customerId).order('equipment_type'),
      supabase
        .from('jobs')
        .select('id, customer_name, service_type, job_status, scheduled_datetime, site_id')
        .eq('customer_id', customerId)
        .order('scheduled_datetime', { ascending: false }),
    ]);
    if (customerRes.data) setCustomer(customerRes.data as Customer);
    if (hierarchyRes.error) {
      toast('Could not load locations', 'error');
    } else {
      setSites((hierarchyRes.data as HierarchySite[]) ?? []);
    }
    setEquipment((equipmentRes.data as Equipment[]) ?? []);
    setJobs(jobsRes.data ?? []);
    setLoading(false);
  }, [user, customerId, toast]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const toggle = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  // ---- Create handlers ----

  const handleAddSite = async () => {
    if (!user || !customerId || !siteDraft.name.trim()) {
      toast('Site name is required', 'error');
      return;
    }
    const { error } = await supabase.from('customer_sites').insert({
      user_id: user.id,
      customer_id: customerId,
      name: siteDraft.name.trim(),
      site_type: siteDraft.site_type,
      address: siteDraft.address.trim() || null,
      is_primary: siteDraft.is_primary,
    });
    if (error) {
      toast('Could not save this site', 'error');
      return;
    }
    setSiteDraft({ name: '', site_type: 'other', address: '', is_primary: false });
    setShowAddSite(false);
    toast('Site added', 'success');
    loadAll();
  };

  const handleAddBuilding = async (siteId: string) => {
    if (!user || !buildingName.trim()) return;
    const { error } = await supabase.from('customer_site_buildings').insert({
      user_id: user.id,
      site_id: siteId,
      name: buildingName.trim(),
    });
    if (error) {
      toast('Could not save this building', 'error');
      return;
    }
    setBuildingName('');
    setAddingBuildingFor(null);
    toast('Building added', 'success');
    loadAll();
  };

  const handleAddFloor = async (buildingId: string) => {
    if (!user || !floorName.trim()) return;
    const { error } = await supabase.from('customer_site_floors').insert({
      user_id: user.id,
      building_id: buildingId,
      name: floorName.trim(),
    });
    if (error) {
      toast('Could not save this floor', 'error');
      return;
    }
    setFloorName('');
    setAddingFloorFor(null);
    toast('Floor added', 'success');
    loadAll();
  };

  const handleAddRoom = async (floorId: string) => {
    if (!user || !roomDraft.name.trim()) return;
    const { error } = await supabase.from('customer_site_rooms').insert({
      user_id: user.id,
      floor_id: floorId,
      name: roomDraft.name.trim(),
      room_type: roomDraft.room_type,
    });
    if (error) {
      toast('Could not save this room', 'error');
      return;
    }
    setRoomDraft({ name: '', room_type: 'other' });
    setAddingRoomFor(null);
    toast('Room added', 'success');
    loadAll();
  };

  // ---- Delete ----

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const table =
      deleteTarget.level === 'site'
        ? 'customer_sites'
        : deleteTarget.level === 'building'
          ? 'customer_site_buildings'
          : deleteTarget.level === 'floor'
            ? 'customer_site_floors'
            : 'customer_site_rooms';
    const { error } = await supabase.from(table).delete().eq('id', deleteTarget.id);
    if (error) {
      toast('Could not delete this', 'error');
    } else {
      toast('Deleted', 'success');
      loadAll();
    }
    setDeleteTarget(null);
  };

  // ---- Asset assignment ----

  const roomOptions = flattenRoomsForPicker(sites);

  const handleAssignAsset = async (equipmentId: string, roomId: string | null) => {
    const { error } = await supabase.from('equipment').update({ room_id: roomId }).eq('id', equipmentId);
    if (error) {
      toast('Could not update this asset', 'error');
      return;
    }
    setEquipment((prev) => prev.map((e) => (e.id === equipmentId ? { ...e, room_id: roomId } : e)));
    loadAll();
  };

  const handleAssignJobSite = async (jobId: string, siteId: string | null) => {
    const { error } = await supabase.from('jobs').update({ site_id: siteId }).eq('id', jobId);
    if (error) {
      toast('Could not update this job', 'error');
      return;
    }
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, site_id: siteId } : j)));
  };

  if (loading) {
    return (
      <DashboardLayout>
        <div className="p-6 text-sm text-text-secondary">Loading locations…</div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl p-4 sm:p-6">
        <button
          type="button"
          onClick={() => navigate(`/dashboard/customers/${customerId}`)}
          className="mb-4 flex items-center gap-1.5 text-xs font-medium text-text-secondary hover:text-accent"
        >
          <ArrowLeft size={14} /> Back to {customer?.name ?? 'customer'}
        </button>

        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">Locations</h1>
            <p className="text-xs text-text-secondary">
              {sites.length} site{sites.length === 1 ? '' : 's'} · {totalRoomCount(sites)} room
              {totalRoomCount(sites) === 1 ? '' : 's'} · {totalAssignedAssetCount(sites)} asset
              {totalAssignedAssetCount(sites) === 1 ? '' : 's'} assigned
            </p>
          </div>
          <button type="button" onClick={() => setShowAddSite((v) => !v)} className={smallBtn}>
            <Plus size={13} /> Add site
          </button>
        </div>

        {showAddSite && (
          <div className="mb-6 rounded-xl border border-border bg-bg-primary p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Site name</label>
                <input
                  className={inputClass}
                  value={siteDraft.name}
                  onChange={(e) => setSiteDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="Downtown Medical Plaza"
                  autoFocus
                />
              </div>
              <div>
                <label className={labelClass}>Site type</label>
                <select
                  className={inputClass}
                  value={siteDraft.site_type}
                  onChange={(e) => setSiteDraft((d) => ({ ...d, site_type: e.target.value as SiteType }))}
                >
                  {SITE_TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {SITE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>Address</label>
                <input
                  className={inputClass}
                  value={siteDraft.address}
                  onChange={(e) => setSiteDraft((d) => ({ ...d, address: e.target.value }))}
                  placeholder="123 Main St, Austin, TX"
                />
              </div>
              <label className="flex items-center gap-2 text-xs font-medium text-text-secondary sm:col-span-2">
                <input
                  type="checkbox"
                  checked={siteDraft.is_primary}
                  onChange={(e) => setSiteDraft((d) => ({ ...d, is_primary: e.target.checked }))}
                />
                Primary site for this account
              </label>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => setShowAddSite(false)} className={smallBtn}>
                <X size={13} /> Cancel
              </button>
              <button
                type="button"
                onClick={handleAddSite}
                className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
              >
                <Check size={13} /> Save site
              </button>
            </div>
          </div>
        )}

        {sites.length === 0 && !showAddSite && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
            <Building2 className="mx-auto mb-2 text-text-secondary/50" size={28} />
            No sites yet. For a multi-location commercial account, add each physical address as a site, then break it down into
            buildings, floors and rooms.
          </div>
        )}

        <div className="space-y-3">
          {sites.map((site) => (
            <div key={site.id} className="rounded-xl border border-border bg-bg-primary">
              <div className="flex items-center justify-between gap-2 p-4">
                <button type="button" onClick={() => toggle(site.id)} className="flex flex-1 items-center gap-2 text-left">
                  {expanded[site.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <MapPin size={15} className="text-accent" />
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                      {site.name}
                      {site.is_primary && <Star size={12} className="fill-warning-500 text-warning-500" />}
                    </div>
                    <div className="text-xs text-text-secondary">
                      {SITE_TYPE_LABELS[site.site_type]}
                      {site.address ? ` · ${site.address}` : ''}
                      {formatSiteLocationLine(site) ? ` · ${formatSiteLocationLine(site)}` : ''}
                    </div>
                  </div>
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => navigate(`/dashboard/customers/${customerId}/sites/${site.id}/twin`)}
                    className={smallBtn}
                  >
                    <Wrench size={12} /> Digital Twin
                  </button>
                  <button type="button" onClick={() => setAddingBuildingFor(site.id)} className={smallBtn}>
                    <Plus size={12} /> Building
                  </button>
                  <button
                    type="button"
                    aria-label="Delete site"
                    onClick={() => setDeleteTarget({ level: 'site', id: site.id, label: site.name })}
                    className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <AnimatePresence>
                {expanded[site.id] && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden border-t border-border"
                  >
                    <div className="space-y-2 p-4 pl-10">
                      {addingBuildingFor === site.id && (
                        <InlineAddRow
                          placeholder="Building A"
                          value={buildingName}
                          onChange={setBuildingName}
                          onSave={() => handleAddBuilding(site.id)}
                          onCancel={() => {
                            setAddingBuildingFor(null);
                            setBuildingName('');
                          }}
                        />
                      )}

                      {site.buildings.length === 0 && addingBuildingFor !== site.id && (
                        <p className="text-xs text-text-secondary">No buildings yet.</p>
                      )}

                      {site.buildings.map((building) => (
                        <div key={building.id} className="rounded-lg border border-border/70 bg-bg-secondary">
                          <div className="flex items-center justify-between gap-2 p-3">
                            <button
                              type="button"
                              onClick={() => toggle(building.id)}
                              className="flex flex-1 items-center gap-2 text-left"
                            >
                              {expanded[building.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              <Building2 size={14} className="text-text-secondary" />
                              <span className="text-sm text-text-primary">{building.name}</span>
                            </button>
                            <div className="flex items-center gap-1.5">
                              <button type="button" onClick={() => setAddingFloorFor(building.id)} className={smallBtn}>
                                <Plus size={12} /> Floor
                              </button>
                              <button
                                type="button"
                                aria-label="Delete building"
                                onClick={() => setDeleteTarget({ level: 'building', id: building.id, label: building.name })}
                                className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>

                          {expanded[building.id] && (
                            <div className="space-y-2 border-t border-border/70 p-3 pl-8">
                              {addingFloorFor === building.id && (
                                <InlineAddRow
                                  placeholder="3rd Floor"
                                  value={floorName}
                                  onChange={setFloorName}
                                  onSave={() => handleAddFloor(building.id)}
                                  onCancel={() => {
                                    setAddingFloorFor(null);
                                    setFloorName('');
                                  }}
                                />
                              )}

                              {building.floors.length === 0 && addingFloorFor !== building.id && (
                                <p className="text-xs text-text-secondary">No floors yet.</p>
                              )}

                              {building.floors.map((floor) => (
                                <div key={floor.id} className="rounded-lg border border-border/60 bg-bg-primary">
                                  <div className="flex items-center justify-between gap-2 p-2.5">
                                    <button
                                      type="button"
                                      onClick={() => toggle(floor.id)}
                                      className="flex flex-1 items-center gap-2 text-left"
                                    >
                                      {expanded[floor.id] ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                      <Layers size={13} className="text-text-secondary" />
                                      <span className="text-sm text-text-primary">{floor.name}</span>
                                    </button>
                                    <div className="flex items-center gap-1.5">
                                      <button type="button" onClick={() => setAddingRoomFor(floor.id)} className={smallBtn}>
                                        <Plus size={12} /> Room
                                      </button>
                                      <button
                                        type="button"
                                        aria-label="Delete floor"
                                        onClick={() => setDeleteTarget({ level: 'floor', id: floor.id, label: floor.name })}
                                        className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-danger/10 hover:text-danger"
                                      >
                                        <Trash2 size={12} />
                                      </button>
                                    </div>
                                  </div>

                                  {expanded[floor.id] && (
                                    <div className="space-y-1.5 border-t border-border/60 p-2.5 pl-7">
                                      {addingRoomFor === floor.id && (
                                        <div className="flex items-center gap-1.5">
                                          <input
                                            className={inputClass}
                                            value={roomDraft.name}
                                            onChange={(e) => setRoomDraft((d) => ({ ...d, name: e.target.value }))}
                                            placeholder="Mechanical Room"
                                            autoFocus
                                          />
                                          <select
                                            className={inputClass}
                                            value={roomDraft.room_type}
                                            onChange={(e) => setRoomDraft((d) => ({ ...d, room_type: e.target.value as RoomType }))}
                                          >
                                            {ROOM_TYPE_OPTIONS.map((t) => (
                                              <option key={t} value={t}>
                                                {ROOM_TYPE_LABELS[t]}
                                              </option>
                                            ))}
                                          </select>
                                          <button
                                            type="button"
                                            onClick={() => handleAddRoom(floor.id)}
                                            className="focus-ring rounded-lg p-2 text-success-500 hover:bg-success-500/10"
                                          >
                                            <Check size={14} />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setAddingRoomFor(null);
                                              setRoomDraft({ name: '', room_type: 'other' });
                                            }}
                                            className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"
                                          >
                                            <X size={14} />
                                          </button>
                                        </div>
                                      )}

                                      {floor.rooms.length === 0 && addingRoomFor !== floor.id && (
                                        <p className="text-xs text-text-secondary">No rooms yet.</p>
                                      )}

                                      {floor.rooms.map((room) => (
                                        <div
                                          key={room.id}
                                          className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-tertiary"
                                        >
                                          <div className="flex items-center gap-2">
                                            <DoorOpen size={13} className="text-text-secondary" />
                                            <span className="text-xs text-text-primary">{room.name}</span>
                                            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">
                                              {ROOM_TYPE_LABELS[room.room_type]}
                                            </span>
                                            {room.asset_count > 0 && (
                                              <span className="flex items-center gap-1 text-[10px] text-text-secondary">
                                                <Wrench size={10} /> {room.asset_count}
                                              </span>
                                            )}
                                          </div>
                                          <button
                                            type="button"
                                            aria-label="Delete room"
                                            onClick={() => setDeleteTarget({ level: 'room', id: room.id, label: room.name })}
                                            className="focus-ring rounded-lg p-1 text-text-secondary hover:bg-danger/10 hover:text-danger"
                                          >
                                            <Trash2 size={12} />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>

        {/* Asset assignment */}
        {equipment.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Assign assets to rooms</h2>
            <div className="space-y-1.5 rounded-xl border border-border bg-bg-primary p-3">
              {equipment.map((eq) => (
                <div key={eq.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                  <div className="flex items-center gap-2 text-xs text-text-primary">
                    <Wrench size={13} className="text-text-secondary" />
                    {[eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type}
                  </div>
                  <select
                    className={`${inputClass} w-auto min-w-[220px]`}
                    value={eq.room_id ?? ''}
                    onChange={(e) => handleAssignAsset(eq.id, e.target.value || null)}
                  >
                    <option value="">Not located</option>
                    {roomOptions.map((opt) => (
                      <option key={opt.roomId} value={opt.roomId}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Job-to-site assignment */}
        {jobs.length > 0 && sites.length > 0 && (
          <div className="mt-6">
            <h2 className="mb-3 text-sm font-semibold text-text-primary">Assign jobs to sites</h2>
            <div className="space-y-1.5 rounded-xl border border-border bg-bg-primary p-3">
              {jobs.map((job) => (
                <div key={job.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
                  <div className="min-w-0 text-xs text-text-primary">
                    <span className="font-medium">{job.service_type ?? 'Job'}</span>
                    {job.scheduled_datetime && (
                      <span className="text-text-secondary"> · {new Date(job.scheduled_datetime).toLocaleDateString()}</span>
                    )}
                    <span className="ml-1.5 rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] capitalize text-text-secondary">
                      {job.job_status}
                    </span>
                  </div>
                  <select
                    className={`${inputClass} w-auto min-w-[220px]`}
                    value={job.site_id ?? ''}
                    onChange={(e) => handleAssignJobSite(job.id, e.target.value || null)}
                  >
                    <option value="">No site</option>
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete "${deleteTarget?.label ?? ''}"?`}
        description={
          deleteTarget?.level === 'site'
            ? 'This removes the site and every building, floor and room inside it. Assets pinned to those rooms are kept but unassigned.'
            : deleteTarget?.level === 'room'
              ? 'Any asset pinned to this room becomes unassigned. The asset itself is not deleted.'
              : 'This removes everything nested inside it. Assets pinned to rooms further down are kept but unassigned.'
        }
        confirmLabel="Yes, delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </DashboardLayout>
  );
}

// ============================================================
// Small shared inline "add" row (used for building + floor forms)
// ============================================================

function InlineAddRow({
  placeholder,
  value,
  onChange,
  onSave,
  onCancel,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="button" onClick={onSave} className="focus-ring rounded-lg p-2 text-success-500 hover:bg-success-500/10">
        <Check size={14} />
      </button>
      <button type="button" onClick={onCancel} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary">
        <X size={14} />
      </button>
    </div>
  );
}
