#!/usr/bin/env python3
"""
Seed Data Generator for Milestone Tenant

This script generates seed data (Staff, Equipment, Skills, Sites) for a tenant database.
It can be run against any tenant database to populate it with realistic demo data.

Usage:
    python scripts/seed_tenant_data.py --tenant-slug <slug>
    python scripts/seed_tenant_data.py --database-url <url>
    
Options:
    --tenant-slug       Tenant slug to look up in master database
    --database-url      Direct database URL (bypasses master lookup)
    --num-staff         Number of staff members to create (default: 20)
    --num-equipment     Number of equipment items to create (default: 15)
    --clear             Clear existing data before seeding
    --dry-run           Show what would be created without making changes
"""

import argparse
import os
import sys
import random
from datetime import datetime
from typing import List, Optional

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, Session

# Sample data for generation
FIRST_NAMES = [
    "Alice", "Bob", "Charlie", "Diana", "Edward", "Fiona", "George", "Hannah",
    "Ivan", "Julia", "Kevin", "Laura", "Michael", "Nina", "Oliver", "Patricia",
    "Quentin", "Rachel", "Samuel", "Tina", "Ulrich", "Victoria", "William", "Xena",
    "Yusuf", "Zoe", "Andreas", "Beatrice", "Conrad", "Daniela", "Erik", "Franziska",
    "Gustav", "Helena", "Igor", "Jasmine", "Klaus", "Luisa", "Marco", "Natalie"
]

LAST_NAMES = [
    "Anderson", "Brown", "Clark", "Davis", "Evans", "Fischer", "Garcia", "Harris",
    "Ivanov", "Johnson", "Kim", "Lee", "Miller", "Nelson", "O'Brien", "Patel",
    "Quinn", "Rodriguez", "Smith", "Taylor", "Underwood", "Vargas", "Williams", "Xavier",
    "Yang", "Zhang", "Mueller", "Schmidt", "Weber", "Wagner", "Becker", "Hoffmann",
    "Schneider", "Meyer", "Wolf", "Schwarz", "Zimmermann", "Braun", "Krueger", "Hartmann"
]

JOB_TITLES = [
    "Research Scientist", "Senior Researcher", "Lab Technician", "Project Manager",
    "Data Analyst", "Process Engineer", "Quality Specialist", "Lab Manager",
    "Research Associate", "Technical Lead", "R&D Engineer", "Analytical Chemist",
    "Biotech Specialist", "Formulation Scientist", "Clinical Researcher",
    "Regulatory Affairs Specialist", "Documentation Specialist", "Safety Officer"
]

SKILLS_DATA = [
    {"name": "Python", "description": "Python programming and data analysis", "color": "#3776ab"},
    {"name": "R Statistics", "description": "Statistical analysis with R", "color": "#276dc3"},
    {"name": "HPLC", "description": "High-Performance Liquid Chromatography", "color": "#e74c3c"},
    {"name": "Mass Spectrometry", "description": "MS analysis techniques", "color": "#9b59b6"},
    {"name": "Cell Culture", "description": "Mammalian and bacterial cell culture", "color": "#27ae60"},
    {"name": "PCR", "description": "Polymerase Chain Reaction techniques", "color": "#f39c12"},
    {"name": "GMP", "description": "Good Manufacturing Practice", "color": "#1abc9c"},
    {"name": "Project Management", "description": "Project planning and execution", "color": "#3498db"},
    {"name": "Data Visualization", "description": "Creating charts and dashboards", "color": "#e67e22"},
    {"name": "Technical Writing", "description": "Documentation and reports", "color": "#95a5a6"},
    {"name": "Machine Learning", "description": "ML model development", "color": "#8e44ad"},
    {"name": "Spectroscopy", "description": "UV-Vis, IR, NMR spectroscopy", "color": "#2ecc71"},
    {"name": "Formulation", "description": "Product formulation development", "color": "#e91e63"},
    {"name": "Validation", "description": "Method and process validation", "color": "#00bcd4"},
    {"name": "Quality Control", "description": "QC testing and procedures", "color": "#ff5722"},
]

EQUIPMENT_DATA = [
    {"name": "HPLC System 1", "type": "Analytical", "description": "Agilent 1260 Infinity II"},
    {"name": "HPLC System 2", "type": "Analytical", "description": "Waters Alliance e2695"},
    {"name": "Mass Spectrometer", "type": "Analytical", "description": "Thermo Q Exactive Plus"},
    {"name": "UV-Vis Spectrophotometer", "type": "Analytical", "description": "Agilent Cary 60"},
    {"name": "FTIR Spectrometer", "type": "Analytical", "description": "Bruker Alpha II"},
    {"name": "PCR Thermocycler 1", "type": "Molecular Biology", "description": "Bio-Rad T100"},
    {"name": "PCR Thermocycler 2", "type": "Molecular Biology", "description": "Applied Biosystems Veriti"},
    {"name": "Real-Time PCR", "type": "Molecular Biology", "description": "QuantStudio 5"},
    {"name": "Centrifuge Large", "type": "General Lab", "description": "Beckman Coulter Avanti J-26S"},
    {"name": "Microcentrifuge", "type": "General Lab", "description": "Eppendorf 5424 R"},
    {"name": "Autoclave", "type": "Sterilization", "description": "Tuttnauer 3870EA"},
    {"name": "Biosafety Cabinet", "type": "Cell Culture", "description": "Thermo 1300 Series Class II"},
    {"name": "CO2 Incubator", "type": "Cell Culture", "description": "Thermo Heracell VIOS 160i"},
    {"name": "Plate Reader", "type": "Analytical", "description": "BioTek Synergy H1"},
    {"name": "Freeze Dryer", "type": "Processing", "description": "Labconco FreeZone 6L"},
    {"name": "Homogenizer", "type": "Processing", "description": "IKA T25 digital ULTRA-TURRAX"},
    {"name": "pH Meter", "type": "General Lab", "description": "Mettler Toledo SevenExcellence"},
    {"name": "Analytical Balance", "type": "General Lab", "description": "Mettler Toledo XPR205"},
    {"name": "Fume Hood 1", "type": "Safety", "description": "Labconco Protector XStream"},
    {"name": "Fume Hood 2", "type": "Safety", "description": "Labconco Protector XStream"},
]

SITES_DATA = [
    {"name": "Winterthur", "city": "Winterthur", "country_code": "CH", "region_code": "ZH", "timezone": "Europe/Zurich"},
    {"name": "Frankfurt", "city": "Frankfurt", "country_code": "DE", "region_code": "HE", "timezone": "Europe/Berlin"},
    {"name": "Lyon", "city": "Lyon", "country_code": "FR", "region_code": "ARA", "timezone": "Europe/Paris"},
    {"name": "Milano", "city": "Milan", "country_code": "IT", "region_code": "MI", "timezone": "Europe/Rome"},
]


def get_database_url_for_tenant(tenant_slug: str, master_db_url: str) -> Optional[str]:
    """Look up tenant database URL from master database."""
    try:
        engine = create_engine(master_db_url)
        with engine.connect() as conn:
            result = conn.execute(
                text("""
                    SELECT t.database_name, t.database_user, tc.encrypted_password
                    FROM tenants t
                    JOIN tenant_credentials tc ON t.id = tc.tenant_id
                    WHERE t.slug = :slug AND t.status = 'active'
                """),
                {"slug": tenant_slug}
            ).fetchone()
            
            if not result:
                print(f"Error: Tenant '{tenant_slug}' not found or not active")
                return None
            
            # Note: encrypted_password would need to be decrypted
            # For now, we'll need the direct database URL
            print(f"Found tenant: database={result[0]}, user={result[1]}")
            print("Note: Use --database-url to provide the full connection string")
            return None
            
    except Exception as e:
        print(f"Error connecting to master database: {e}")
        return None


def clear_existing_data(session: Session, dry_run: bool = False):
    """Clear existing seed data from the database."""
    tables_to_clear = [
        "user_skills",
        "user_sites", 
        "vacations",
        "equipment_assignments",
        "phase_staff_assignments",
        "subphase_staff_assignments",
        "project_assignments",
        "equipment",
        "skills",
        "users",
        # Don't clear sites - they may have projects attached
    ]
    
    print("\n🗑️  Clearing existing data...")
    
    for table in tables_to_clear:
        if dry_run:
            print(f"  Would clear: {table}")
        else:
            try:
                result = session.execute(text(f"DELETE FROM {table}"))
                print(f"  Cleared: {table} ({result.rowcount} rows)")
            except Exception as e:
                print(f"  Warning: Could not clear {table}: {e}")
    
    if not dry_run:
        session.commit()


def create_sites(session: Session, dry_run: bool = False) -> List[int]:
    """Create sites and return their IDs."""
    print("\n🏢 Creating sites...")
    site_ids = []
    
    for site_data in SITES_DATA:
        # Check if site already exists
        existing = session.execute(
            text("SELECT id FROM sites WHERE name = :name"),
            {"name": site_data["name"]}
        ).fetchone()
        
        if existing:
            print(f"  Site '{site_data['name']}' already exists (id={existing[0]})")
            site_ids.append(existing[0])
            continue
        
        if dry_run:
            print(f"  Would create: {site_data['name']}")
            site_ids.append(len(site_ids) + 1)
        else:
            result = session.execute(
                text("""
                    INSERT INTO sites (name, city, country_code, region_code, timezone, location, active, created_at)
                    VALUES (:name, :city, :country_code, :region_code, :timezone, :city, 1, NOW())
                    RETURNING id
                """),
                site_data
            )
            site_id = result.fetchone()[0]
            site_ids.append(site_id)
            print(f"  Created: {site_data['name']} (id={site_id})")
    
    if not dry_run:
        session.commit()
    
    return site_ids


def create_skills(session: Session, dry_run: bool = False) -> List[int]:
    """Create skills and return their IDs."""
    print("\n🎯 Creating skills...")
    skill_ids = []
    
    for skill_data in SKILLS_DATA:
        # Check if skill already exists
        existing = session.execute(
            text("SELECT id FROM skills WHERE name = :name"),
            {"name": skill_data["name"]}
        ).fetchone()
        
        if existing:
            print(f"  Skill '{skill_data['name']}' already exists (id={existing[0]})")
            skill_ids.append(existing[0])
            continue
        
        if dry_run:
            print(f"  Would create: {skill_data['name']}")
            skill_ids.append(len(skill_ids) + 1)
        else:
            result = session.execute(
                text("""
                    INSERT INTO skills (name, description, color, created_at, updated_at)
                    VALUES (:name, :description, :color, NOW(), NOW())
                    RETURNING id
                """),
                skill_data
            )
            skill_id = result.fetchone()[0]
            skill_ids.append(skill_id)
            print(f"  Created: {skill_data['name']} (id={skill_id})")
    
    if not dry_run:
        session.commit()
    
    return skill_ids


def create_staff(session: Session, site_ids: List[int], skill_ids: List[int], 
                 num_staff: int, dry_run: bool = False) -> List[int]:
    """Create staff members and return their IDs."""
    print(f"\n👥 Creating {num_staff} staff members...")
    staff_ids = []
    
    # Generate unique name combinations
    used_names = set()
    
    for i in range(num_staff):
        # Generate unique name
        while True:
            first_name = random.choice(FIRST_NAMES)
            last_name = random.choice(LAST_NAMES)
            full_name = f"{first_name} {last_name}"
            if full_name not in used_names:
                used_names.add(full_name)
                break
        
        email = f"{first_name.lower()}.{last_name.lower()}@example.com"
        job_title = random.choice(JOB_TITLES)
        
        # Assign to 1-2 random sites
        num_sites = random.randint(1, min(2, len(site_ids)))
        assigned_sites = random.sample(site_ids, num_sites)
        
        # Assign 2-5 random skills with proficiency
        num_skills = random.randint(2, min(5, len(skill_ids)))
        assigned_skills = random.sample(skill_ids, num_skills)
        
        # First user is admin, some are superusers, rest are users
        if i == 0:
            role = "admin"
        elif i < 3:
            role = "superuser"
        else:
            role = "user"
        
        if dry_run:
            print(f"  Would create: {full_name} ({job_title}) - {role}")
            staff_ids.append(i + 1)
        else:
            # Create user
            result = session.execute(
                text("""
                    INSERT INTO users (email, password, first_name, last_name, job_title, role, active, created_at, updated_at)
                    VALUES (:email, :password, :first_name, :last_name, :job_title, :role, 1, NOW(), NOW())
                    RETURNING id
                """),
                {
                    "email": email,
                    "password": "$2b$12$placeholder.hash.for.demo.data",  # Not a real password
                    "first_name": first_name,
                    "last_name": last_name,
                    "job_title": job_title,
                    "role": role,
                }
            )
            user_id = result.fetchone()[0]
            staff_ids.append(user_id)
            
            # Assign to sites
            for site_id in assigned_sites:
                session.execute(
                    text("INSERT INTO user_sites (user_id, site_id) VALUES (:user_id, :site_id)"),
                    {"user_id": user_id, "site_id": site_id}
                )
            
            # Assign skills with random proficiency
            for skill_id in assigned_skills:
                proficiency = random.randint(1, 5)
                session.execute(
                    text("""
                        INSERT INTO user_skills (user_id, skill_id, proficiency, assigned_at)
                        VALUES (:user_id, :skill_id, :proficiency, NOW())
                    """),
                    {"user_id": user_id, "skill_id": skill_id, "proficiency": proficiency}
                )
            
            sites_str = ", ".join([str(s) for s in assigned_sites])
            print(f"  Created: {full_name} ({job_title}) - {role} - sites: [{sites_str}]")
    
    if not dry_run:
        session.commit()
    
    return staff_ids


def create_equipment(session: Session, site_ids: List[int], 
                     num_equipment: int, dry_run: bool = False) -> List[int]:
    """Create equipment items and return their IDs."""
    print(f"\n🔧 Creating {num_equipment} equipment items...")
    equipment_ids = []
    
    # Use predefined equipment or generate more if needed
    equipment_list = EQUIPMENT_DATA[:num_equipment]
    
    # If we need more equipment than predefined, generate additional
    if num_equipment > len(EQUIPMENT_DATA):
        extra_types = ["Analytical", "General Lab", "Processing", "Cell Culture", "Safety"]
        for i in range(num_equipment - len(EQUIPMENT_DATA)):
            equipment_list.append({
                "name": f"Equipment {len(EQUIPMENT_DATA) + i + 1}",
                "type": random.choice(extra_types),
                "description": f"Additional lab equipment #{i + 1}"
            })
    
    for i, equip_data in enumerate(equipment_list):
        # Assign to a random site
        site_id = random.choice(site_ids)
        
        if dry_run:
            print(f"  Would create: {equip_data['name']} ({equip_data['type']})")
            equipment_ids.append(i + 1)
        else:
            result = session.execute(
                text("""
                    INSERT INTO equipment (name, type, description, site_id, active, created_at)
                    VALUES (:name, :type, :description, :site_id, 1, NOW())
                    RETURNING id
                """),
                {
                    "name": equip_data["name"],
                    "type": equip_data["type"],
                    "description": equip_data.get("description", ""),
                    "site_id": site_id,
                }
            )
            equip_id = result.fetchone()[0]
            equipment_ids.append(equip_id)
            print(f"  Created: {equip_data['name']} ({equip_data['type']}) - site_id={site_id}")
    
    if not dry_run:
        session.commit()
    
    return equipment_ids


def main():
    parser = argparse.ArgumentParser(
        description="Generate seed data for a Milestone tenant database",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate seed data using direct database URL
  python scripts/seed_tenant_data.py --database-url "postgresql://user:pass@localhost/tenant_db"
  
  # Generate with custom amounts
  python scripts/seed_tenant_data.py --database-url "..." --num-staff 30 --num-equipment 20
  
  # Preview what would be created (dry run)
  python scripts/seed_tenant_data.py --database-url "..." --dry-run
  
  # Clear existing data before seeding
  python scripts/seed_tenant_data.py --database-url "..." --clear
        """
    )
    
    parser.add_argument("--tenant-slug", help="Tenant slug to look up in master database")
    parser.add_argument("--database-url", help="Direct database URL for tenant")
    parser.add_argument("--num-staff", type=int, default=20, help="Number of staff to create (default: 20)")
    parser.add_argument("--num-equipment", type=int, default=15, help="Number of equipment to create (default: 15)")
    parser.add_argument("--clear", action="store_true", help="Clear existing data before seeding")
    parser.add_argument("--dry-run", action="store_true", help="Preview without making changes")
    
    args = parser.parse_args()
    
    # Determine database URL
    database_url = args.database_url
    
    if not database_url and args.tenant_slug:
        master_url = os.environ.get("MASTER_DATABASE_URL", "postgresql://milestone_admin:password@localhost/milestone_admin")
        database_url = get_database_url_for_tenant(args.tenant_slug, master_url)
    
    if not database_url:
        print("Error: Please provide --database-url or --tenant-slug")
        print("\nExample:")
        print('  python scripts/seed_tenant_data.py --database-url "postgresql://user:pass@localhost/tenant_db"')
        sys.exit(1)
    
    print("=" * 60)
    print("🌱 Milestone Seed Data Generator")
    print("=" * 60)
    print(f"\nDatabase: {database_url.split('@')[-1] if '@' in database_url else database_url}")
    print(f"Staff: {args.num_staff}")
    print(f"Equipment: {args.num_equipment}")
    print(f"Skills: {len(SKILLS_DATA)}")
    print(f"Sites: {len(SITES_DATA)}")
    if args.dry_run:
        print("\n⚠️  DRY RUN MODE - No changes will be made")
    if args.clear:
        print("\n⚠️  CLEAR MODE - Existing data will be deleted")
    
    # Connect to database
    try:
        engine = create_engine(database_url)
        SessionLocal = sessionmaker(bind=engine)
        session = SessionLocal()
        
        # Test connection
        session.execute(text("SELECT 1"))
        print("\n✅ Database connection successful")
        
    except Exception as e:
        print(f"\n❌ Database connection failed: {e}")
        sys.exit(1)
    
    try:
        # Clear existing data if requested
        if args.clear:
            clear_existing_data(session, args.dry_run)
        
        # Create data
        site_ids = create_sites(session, args.dry_run)
        skill_ids = create_skills(session, args.dry_run)
        staff_ids = create_staff(session, site_ids, skill_ids, args.num_staff, args.dry_run)
        equipment_ids = create_equipment(session, site_ids, args.num_equipment, args.dry_run)
        
        # Summary
        print("\n" + "=" * 60)
        print("📊 Summary")
        print("=" * 60)
        print(f"  Sites: {len(site_ids)}")
        print(f"  Skills: {len(skill_ids)}")
        print(f"  Staff: {len(staff_ids)}")
        print(f"  Equipment: {len(equipment_ids)}")
        
        if args.dry_run:
            print("\n⚠️  DRY RUN - No changes were made")
        else:
            print("\n✅ Seed data created successfully!")
        
    except Exception as e:
        print(f"\n❌ Error creating seed data: {e}")
        session.rollback()
        raise
    finally:
        session.close()


if __name__ == "__main__":
    main()
