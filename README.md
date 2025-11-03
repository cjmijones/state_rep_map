# A Next JS Web App Project with the Goal of Visualizing the Geographic Bounds of Every State Legislative District in the United States

### Primary Contributor: CJ Jones

## Data Sourcing

The U.S. Census Bureau produces current shape file directories for every Upper SLD and Lower SLD within the United States

- **Metadata & Data Download Available:**
  - [Lower SLD Metadata](https://catalog.data.gov/dataset/series-information-for-state-legislative-district-sld-lower-chamber-state-based-tiger-line-shap)
  - [Upper SLD Metadata](https://catalog.data.gov/dataset/series-information-for-state-legislative-district-sld-upper-chamber-state-based-tiger-line-shap)

- **Series Notes:**
  - Nebraska has a unicameral legislature, and the District of Columbia has a single council, both of which the Census Bureau treats as upper-chamber legislative areas for the purpose of data presentation.
  - A unique three-character census code, identified by state participants, is assigned to each SLD within a state.
  - In the areas with no SLDUs defined, the code "ZZZ" has been assigned, which is treated as a single SLDU.
  - There are no Upper SLD TIGER/Line shapefiles for the Island Areas.
  - There are no SLDL TIGER/Line shapefiles for the District of Columbia, Nebraska, and the Island Areas.
  - The state legislative district boundaries reflect information provided to the Census Bureau by the states by May 31, 2024.

### Package and Code Setup

### Requirements
- Python **3.11 -3.12**
- Conda Package Manager
- NPM
- Next JS
- Supabase
- Docker
- Tippecanoe (cli)

### For Backend Setup

```bash
# cd to backend directory
cd state-rep-backend

# new conda env with Python 3.11
conda create -n sld-vis python=3.12 -y

# activate env
conda activate sld-vis

# install local package and dependencies via poetry
poetry install
```

### Data Cleaning & Construction

**Prior to Running Scripts Ensure Correct File Structure and Output Variables via state_rep_map_build/config.py**

```bash
# From inside the backend directory
# This set will create the upper and lower directories within data/geojson that will each contain the State Geojs  
poetry run python state_rep_map_builder/unpack_and_geojson.py

# Expected to see print statements that detail the actions being taken
```
> **⚠️ WARNING:**  
> You must have tippecanoe installed on your machine - use `sudo apt install tippecanoe` on WSL
 
```bash
poetry run python -m state_rep_map_builder.build_mbtiles

```


