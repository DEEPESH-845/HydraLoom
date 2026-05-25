import cv2
import numpy as np
import math

def generate_underwater_video(filename="underwater.mp4", num_frames=150, width=640, height=480, fps=30):
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(filename, fourcc, fps, (width, height))
    
    print("Generating procedural underwater footage...")
    for frame_idx in range(num_frames):
        # Base deep sea gradient
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        for y in range(height):
            # Blue-green depth gradient
            b = int(120 - (y / height) * 80)
            g = int(80 - (y / height) * 60)
            r = int(20 - (y / height) * 20)
            frame[y, :] = (b, g, r)
            
        # Caustics (light rays)
        time = frame_idx * 0.1
        for i in range(5):
            x1 = int(width/2 + math.sin(time + i) * 200)
            x2 = int(width/2 + math.sin(time*0.8 + i) * 300)
            pts = np.array([[x1, 0], [x1+40, 0], [x2+80, height], [x2, height]])
            overlay = frame.copy()
            cv2.fillPoly(overlay, [pts], (200, 255, 255))
            cv2.addWeighted(overlay, 0.1, frame, 0.9, 0, frame)

        # Marine snow
        np.random.seed(42) # Consistent snow pattern
        for _ in range(100):
            sx = np.random.randint(0, width)
            sy = (np.random.randint(0, height) + int(frame_idx * 2)) % height
            cv2.circle(frame, (sx, sy), 1, (200, 200, 200), -1)

        # Draw a floating "sports ball" to trigger YOLOv8 COCO class 32 (sports ball)
        # Bouncing slowly
        ball_y = int(height/2 + math.sin(time * 0.5) * 100)
        ball_x = int(width/2 + math.cos(time * 0.3) * 150)
        cv2.circle(frame, (ball_x, ball_y), 30, (50, 50, 200), -1) # Reddish ball
        # Shading
        cv2.circle(frame, (ball_x-10, ball_y-10), 10, (100, 100, 250), -1)

        # Draw a "bottle" to trigger COCO class 39 (bottle)
        bottle_x = int(width/4 + math.sin(time * 0.7) * 50)
        bottle_y = int(height/3 + math.cos(time * 0.4) * 50)
        cv2.rectangle(frame, (bottle_x-15, bottle_y), (bottle_x+15, bottle_y+60), (200, 200, 50), -1)
        cv2.rectangle(frame, (bottle_x-5, bottle_y-20), (bottle_x+5, bottle_y), (200, 200, 50), -1)
        # Cap
        cv2.rectangle(frame, (bottle_x-7, bottle_y-25), (bottle_x+7, bottle_y-20), (50, 50, 50), -1)
        
        # Add some blur to simulate water depth and focus
        frame = cv2.GaussianBlur(frame, (5, 5), 0)

        out.write(frame)
        
    out.release()
    print(f"Generated {filename}")

if __name__ == "__main__":
    generate_underwater_video()
