/**
 * MS Project XML Export Utility
 * 
 * Exports projects to Microsoft Project XML format entirely client-side.
 */

import type { Project, Subphase } from '@/types';
import { format } from 'date-fns';
import { toDateOnly } from './date';

/**
 * Create MS Project XML from a project
 */
export function createMSProjectXML(project: Project): string {
  const lines: string[] = [];
  
  // XML declaration
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push('<Project xmlns="http://schemas.microsoft.com/project">');
  
  // Project properties
  lines.push(`  <Name>${escapeXml(project.name)}</Name>`);
  lines.push(`  <Title>${escapeXml(project.name)}</Title>`);
  lines.push(`  <Company>${escapeXml(project.customer || '')}</Company>`);
  
  if (project.start_date) {
    lines.push(`  <StartDate>${xmlDate(project.start_date)}T08:00:00</StartDate>`);
  }
  if (project.end_date) {
    lines.push(`  <FinishDate>${xmlDate(project.end_date)}T17:00:00</FinishDate>`);
  }
  
  lines.push('  <ScheduleFromStart>1</ScheduleFromStart>');
  lines.push(`  <CurrentDate>${format(new Date(), "yyyy-MM-dd'T'HH:mm:ss")}</CurrentDate>`);
  lines.push('  <CalendarUID>1</CalendarUID>');
  
  // Calendar
  lines.push('  <Calendars>');
  lines.push('    <Calendar>');
  lines.push('      <UID>1</UID>');
  lines.push('      <Name>Standard</Name>');
  lines.push('      <IsBaseCalendar>1</IsBaseCalendar>');
  lines.push('    </Calendar>');
  lines.push('  </Calendars>');
  
  // Tasks
  lines.push('  <Tasks>');
  
  let uid = 0;
  
  // Helper to add a task
  const addTask = (
    name: string,
    startDate: string | null | undefined,
    endDate: string | null | undefined,
    outlineLevel: number,
    isMilestone: boolean = false,
    completion: number = 0
  ) => {
    uid++;
    lines.push('    <Task>');
    lines.push(`      <UID>${uid}</UID>`);
    lines.push(`      <ID>${uid}</ID>`);
    lines.push(`      <Name>${escapeXml(name)}</Name>`);
    lines.push(`      <OutlineLevel>${outlineLevel}</OutlineLevel>`);
    if (startDate) {
      lines.push(`      <Start>${xmlDate(startDate)}T08:00:00</Start>`);
    }
    if (endDate) {
      lines.push(`      <Finish>${xmlDate(endDate)}T17:00:00</Finish>`);
    }
    lines.push(`      <Milestone>${isMilestone ? '1' : '0'}</Milestone>`);
    lines.push(`      <PercentComplete>${completion || 0}</PercentComplete>`);
    lines.push('    </Task>');
  };
  
  // Project summary task
  addTask(project.name, project.start_date, project.end_date, 0);
  
  // Phases
  for (const phase of project.phases || []) {
    const isMilestone = xmlDate(phase.start_date) === xmlDate(phase.end_date);
    addTask(phase.name, phase.start_date, phase.end_date, 1, isMilestone, phase.completion || 0);
    
    // Subphases (children)
    const addChildren = (children: Subphase[] | undefined, level: number) => {
      for (const child of children || []) {
        const childMilestone = xmlDate(child.start_date) === xmlDate(child.end_date);
        addTask(child.name, child.start_date, child.end_date, level, childMilestone, child.completion || 0);
        // Recurse for nested children
        if (child.children && child.children.length > 0) {
          addChildren(child.children, level + 1);
        }
      }
    };
    
    addChildren(phase.children, 2);
  }
  
  lines.push('  </Tasks>');
  
  // Empty resources and assignments
  lines.push('  <Resources/>');
  lines.push('  <Assignments/>');
  
  lines.push('</Project>');
  
  return lines.join('\n');
}

/**
 * Calendar date part of a model date. Model dates arrive either as
 * `YYYY-MM-DD` or as the backend's midnight-UTC `YYYY-MM-DDT00:00:00.000Z`;
 * appending a time to the latter produced invalid MS Project XML.
 */
function xmlDate(value: string): string {
  return escapeXml(toDateOnly(value));
}

/**
 * Characters XML 1.0 does not allow at all, even escaped (C0 controls other
 * than tab/LF/CR, lone surrogates, U+FFFE/U+FFFF).
 */
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escape XML special characters
 */
export function escapeXml(str: string): string {
  return str
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Download XML as a file
 */
export function downloadXML(xml: string, filename: string): void {
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Export project to MS Project XML and download
 */
export function exportProjectToXML(project: Project): void {
  const xml = createMSProjectXML(project);
  const filename = `${project.name.replace(/\s+/g, '_')}.xml`;
  downloadXML(xml, filename);
}
