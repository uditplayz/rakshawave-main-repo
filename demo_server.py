"""
Simple demo server for RakshaWave hackathon - works without full dependencies.
Run with: python demo_server.py
"""

import json
import time
import random
import asyncio
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
import threading
from datetime import datetime

# Simulated data
vehicles = []
events = []
clusters = []
emergencies = []
tick_count = 0

# Pune coordinates
BASE_LAT = 18.5204
BASE_LON = 73.8567

HAZARD_TYPES = ['pothole', 'crack', 'debris']

class RakshaWaveHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='ui', **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == '/':
            self.send_response(302)
            self.send_header('Location', '/index.html')
            self.end_headers()
            return

        elif parsed.path == '/api/health':
            self.send_json({'status': 'ok', 'vehicle_count': len(vehicles)})

        elif parsed.path == '/api/fleet':
            self.send_json(get_snapshot())

        elif parsed.path == '/api/events':
            self.send_json([e for e in events[-50:]])

        elif parsed.path == '/api/clusters':
            self.send_json(clusters)

        elif parsed.path == '/api/emergencies':
            self.send_json(emergencies)

        else:
            # Serve static files from ui/ directory
            super().do_GET()

    def send_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        # Suppress HTTP logs for cleaner output
        pass

def get_snapshot():
    return {
        'vehicles': vehicles,
        'recent_events': events[-20:],
        'clusters': clusters,
        'emergencies': emergencies,
        'stats': {
            'active_vehicles': len(vehicles),
            'packets_on_air': random.randint(50, 200),
            'verified_events': len([e for e in events if e.get('verified')]),
            'tick_count': tick_count
        }
    }

def random_offset():
    return (random.random() - 0.5) * 0.02

def init_simulation():
    global vehicles, events, clusters, emergencies

    # Create 5-8 vehicles
    vehicle_count = random.randint(5, 8)
    for i in range(vehicle_count):
        vehicles.append({
            'vehicle_id': f'VEH-{str(i+1).zfill(3)}',
            'lat': BASE_LAT + random_offset(),
            'lon': BASE_LON + random_offset(),
            'speed_kmh': random.randint(30, 80),
            'timestamp': int(time.time())
        })

    # Create some initial hazards
    for i in range(3):
        hazard_type = random.choice(HAZARD_TYPES)
        lat = BASE_LAT + random_offset()
        lon = BASE_LON + random_offset()
        confidence = random.uniform(0.7, 0.95)
        created_at = int(time.time()) - random.randint(60, 300)

        event = {
            'vehicle_id': random.choice(vehicles)['vehicle_id'],
            'hazard_type': hazard_type,
            'lat': lat,
            'lon': lon,
            'fused_confidence': confidence,
            'verified': confidence > 0.8,
            'created_at': created_at
        }
        events.append(event)

        # Create a cluster for verified hazards
        if event['verified']:
            clusters.append({
                'cluster_id': f'CLU-{len(clusters)+1:03d}',
                'hazard_type': hazard_type,
                'lat': lat,
                'lon': lon,
                'max_confidence': confidence,
                'report_count': random.randint(2, 4),
                'corroborating_vehicles': [random.choice(vehicles)['vehicle_id'] for _ in range(2)],
                'escalated': random.random() < 0.2,
                'first_seen_at': created_at
            })

    # Create 1 emergency (20% chance)
    if random.random() < 0.3 and clusters:
        emergency_cluster = random.choice(clusters)
        emergencies.append({
            'cluster_id': emergency_cluster['cluster_id'],
            'hazard_type': emergency_cluster['hazard_type'],
            'lat': emergency_cluster['lat'],
            'lon': emergency_cluster['lon'],
            'corroborating_vehicles': emergency_cluster['corroborating_vehicles'],
            'escalated': True
        })

def simulation_tick():
    global tick_count, vehicles, events, clusters, emergencies

    tick_count += 1

    # Move vehicles slightly
    for vehicle in vehicles:
        vehicle['lat'] += (random.random() - 0.5) * 0.0005
        vehicle['lon'] += (random.random() - 0.5) * 0.0005
        vehicle['speed_kmh'] = max(20, min(100, vehicle['speed_kmh'] + random.randint(-5, 5)))
        vehicle['timestamp'] = int(time.time())

    # Occasionally add new hazard (every ~10 ticks)
    if random.random() < 0.1:
        hazard_type = random.choice(HAZARD_TYPES)
        lat = BASE_LAT + random_offset()
        lon = BASE_LON + random_offset()
        confidence = random.uniform(0.65, 0.95)

        event = {
            'vehicle_id': random.choice(vehicles)['vehicle_id'],
            'hazard_type': hazard_type,
            'lat': lat,
            'lon': lon,
            'fused_confidence': confidence,
            'verified': confidence > 0.8,
            'created_at': int(time.time())
        }
        events.append(event)

        # Create cluster for high-confidence hazards
        if confidence > 0.85 and random.random() < 0.6:
            new_cluster = {
                'cluster_id': f'CLU-{len(clusters)+1:03d}',
                'hazard_type': hazard_type,
                'lat': lat,
                'lon': lon,
                'max_confidence': confidence,
                'report_count': random.randint(2, 3),
                'corroborating_vehicles': [random.choice(vehicles)['vehicle_id'] for _ in range(2)],
                'escalated': random.random() < 0.15,
                'first_seen_at': int(time.time())
            }
            clusters.append(new_cluster)

            # Small chance to escalate to emergency
            if new_cluster['escalated'] and random.random() < 0.3:
                emergencies.append({
                    'cluster_id': new_cluster['cluster_id'],
                    'hazard_type': new_cluster['hazard_type'],
                    'lat': new_cluster['lat'],
                    'lon': new_cluster['lon'],
                    'corroborating_vehicles': new_cluster['corroborating_vehicles'],
                    'escalated': True
                })

    # Keep events list manageable
    if len(events) > 100:
        events = events[-80:]

    # Keep clusters manageable
    if len(clusters) > 20:
        clusters = clusters[-15:]

def run_simulation_loop():
    while True:
        simulation_tick()
        time.sleep(2)  # Tick every 2 seconds

def main():
    print("=" * 70)
    print("  RakshaWave - Smart Road Sentinel (Demo Server)")
    print("=" * 70)
    print("\nInitializing simulation...")

    init_simulation()

    print(f"  Created {len(vehicles)} virtual vehicles")
    print(f"  Generated {len(events)} initial hazards")
    print(f"  Active clusters: {len(clusters)}")

    # Start simulation in background
    sim_thread = threading.Thread(target=run_simulation_loop, daemon=True)
    sim_thread.start()

    # Start HTTP server
    port = 8000
    server = HTTPServer(('0.0.0.0', port), RakshaWaveHandler)

    print("\n" + "=" * 70)
    print(f"  Server running at http://localhost:{port}")
    print("=" * 70)
    print("\n  Open the PWA (live phone-to-phone mode needs: uvicorn server.app:app):")
    print(f"   -> http://localhost:{port}/index.html")
    print("\n  API Endpoints:")
    print(f"   -> http://localhost:{port}/api/fleet")
    print(f"   -> http://localhost:{port}/api/events")
    print(f"   -> http://localhost:{port}/api/clusters")
    print(f"   -> http://localhost:{port}/api/emergencies")
    print("\n  Press Ctrl+C to stop\n")
    print("=" * 70)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n\nShutting down server...")
        server.shutdown()

if __name__ == '__main__':
    main()
