import { useAppStore } from '@/stores/appStore';
import { uniqueById } from '@/utils/uniqueById';
import { useViewStore } from '@/stores/viewStore';
import { useTeamFilter } from '@/hooks/useTeamFilter';
import { ResourceCard } from './ResourceCard';
import styles from './ResourceList.module.css';

export function ResourceList() {
  const currentResourceTab = useViewStore((s) => s.currentResourceTab);
  const staff = useAppStore((s) => s.staff);
  const equipment = useAppStore((s) => s.equipment);
  const currentSite = useAppStore((s) => s.currentSite);
  const { staffMatches, equipmentMatches } = useTeamFilter();

  // Subscribe to projects to pass to ResourceCards
  const projects = useAppStore((s) => s.projects);

  // Filter by current site and its header team filter
  const filteredStaff = currentSite
    ? staff.filter((s) => s.site_id === currentSite.id && s.active && staffMatches(s))
    : staff.filter((s) => s.active);

  const filteredEquipment = currentSite
    ? equipment.filter((e) => e.site_id === currentSite.id && e.active && equipmentMatches(e))
    : // One row per equipment-site pair: count each item once
      uniqueById(equipment.filter((e) => e.active));

  const resources = currentResourceTab === 'staff' ? filteredStaff : filteredEquipment;

  if (resources.length === 0) {
    return (
      <div className={styles.empty}>
        <p>No {currentResourceTab} found</p>
      </div>
    );
  }

  return (
    <div className={styles.list}>
      {resources.map((resource) => (
        <ResourceCard
          key={resource.id}
          resource={resource}
          type={currentResourceTab}
          projects={projects}
        />
      ))}
    </div>
  );
}
