"""Guard the map's distinction between upcoming and past Washington notices."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from state_rep_map_builder import refresh_washington_legislature as washington


SNAPSHOT = Path(__file__).resolve().parents[2] / "state-rep-map-visualizationo/public/data/wa-legislature-pilot.json"


class WashingtonAgendaSnapshotTest(unittest.TestCase):
    def test_schedule_separates_future_from_history(self):
        snapshot = json.loads(SNAPSHOT.read_text())
        schedule = snapshot["schedule"]
        as_of = schedule["asOfDate"]
        self.assertTrue(schedule["upcomingMeetings"] or schedule["historicalMeetings"])
        self.assertTrue(all(item["date"][:10] >= as_of for item in schedule["upcomingMeetings"]))
        self.assertTrue(all(item["date"][:10] < as_of for item in schedule["historicalMeetings"]))
        self.assertEqual(schedule["nextRegularSession"]["status"], "tentative")

    def test_joint_and_other_are_not_house_meetings(self):
        self.assertEqual(washington.chamber_from_agency("House"), "lower")
        self.assertEqual(washington.chamber_from_agency("Senate"), "upper")
        self.assertEqual(washington.chamber_from_agency("Joint"), "joint")
        self.assertEqual(washington.chamber_from_agency("Other"), "other")
        with self.assertRaises(ValueError):
            washington.chamber_from_agency("Unknown")

    def test_schedule_refresh_preserves_vote_snapshot(self):
        before = json.loads(SNAPSHOT.read_text())
        replacement = [{"id": "future-meeting", "date": "2026-10-03T12:00:00", "chamber": "upper"}]
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "wa.json"
            output.write_text(json.dumps(before))
            with patch.object(sys, "argv", ["refresh_washington_legislature", "--output", str(output),
                                            "--schedule-only", "--as-of", "2026-10-01"]), \
                 patch.object(washington, "upcoming_agendas", return_value=(replacement, [], washington.date(2026, 12, 1))):
                washington.main()
            after = json.loads(output.read_text())
        self.assertEqual(after["rolls"], before["rolls"])
        self.assertEqual(after["memberCrosswalk"], before["memberCrosswalk"])
        self.assertEqual(after["generatedAt"], before["generatedAt"])
        self.assertEqual(after["schedule"]["upcomingMeetings"], replacement)
        self.assertEqual(after["schedule"]["asOfDate"], "2026-10-01")
        self.assertEqual(after["coverage"]["upcomingAgendaDateRange"], ["2026-10-01", "2026-12-01"])


if __name__ == "__main__":
    unittest.main()
