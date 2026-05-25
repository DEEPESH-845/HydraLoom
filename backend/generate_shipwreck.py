import cv2
import numpy as np

def generate():
    print("Generating cinematic shipwreck video...")
    # Load image
    img = cv2.imread("/Users/deepesh/.gemini/antigravity/brain/1cff1127-12b2-4921-81d3-c28de0801ac3/shipwreck_bedrock_1779675954228.png")
    
    if img is None:
        print("Error: Could not load image")
        return
        
    # Crop out the text on the corners (top and bottom 150 pixels)
    h, w = img.shape[:2]
    img = img[150:h-150, 50:w-50]
    
    # Target size
    out_w, out_h = 640, 480
    
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter("underwater.mp4", fourcc, 30, (out_w, out_h))
    
    total_frames = 300 # 10 seconds
    
    for i in range(total_frames):
        # Calculate pan
        img_h, img_w = img.shape[:2]
        
        # We want the shipwreck to be slightly zoomed in so we can pan
        scale = (out_h + 100) / img_h
        resized = cv2.resize(img, (int(img_w * scale * 1.2), int(img_h * scale * 1.2)))
        
        r_h, r_w = resized.shape[:2]
        
        # Pan across x, bob across y
        progress = i / total_frames
        
        max_x = r_w - out_w
        x = int(progress * max_x)
        
        # Bobbing
        y = 50 + int(np.sin(progress * 15) * 20)
        
        frame = resized[y:y+out_h, x:x+out_w].copy()
        
        # Draw some marine snow to make it look alive
        np.random.seed(42)
        for _ in range(80):
            sx = np.random.randint(0, out_w)
            sy = (np.random.randint(0, out_h) + int(i * 2.5)) % out_h
            # Give snow some subtle lateral drift
            sx = (sx + int(np.sin(i*0.05 + sy)*5)) % out_w
            cv2.circle(frame, (sx, sy), 1, (200, 200, 200), -1)
            
        out.write(frame)
        
    out.release()
    print("Done writing underwater.mp4")

if __name__ == "__main__":
    generate()
