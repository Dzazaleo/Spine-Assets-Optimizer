
import { GlobalAssetStat, OptimizationTask } from '../types';
import JSZip from 'jszip';

/**
 * Calculates which files need optimization based on aggregated global statistics.
 * Respects original dimensions, max usage scale, user overrides, and safety buffer.
 * Capped at physical source dimensions to prevent upscaling.
 */
export function calculateOptimizationTargets(
  stats: GlobalAssetStat[], 
  loadedImages: Map<string, { width: number, height: number, sourceWidth?: number, sourceHeight?: number, file: File, originalPath: string }>,
  bufferPercentage: number = 0
): OptimizationTask[] {
  
  // Create a lookup for stats for O(1) access
  const statsMap = new Map<string, GlobalAssetStat>();
  stats.forEach(s => statsMap.set(s.lookupKey, s));

  const tasks: OptimizationTask[] = [];

  // Iterate over physically loaded images to determine their fate
  loadedImages.forEach((original, key) => {
    const stat = statsMap.get(key);
    
    // CRITICAL: Unused Image Exclusion
    // If the image is not referenced in the global stats, it is unused.
    // We strictly exclude it from the optimization/output package.
    if (!stat) return;
    
    // Use physical source dimensions as the absolute cap.
    // If sourceWidth is undefined, fallback to width (canonical), though raw assets usually have sourceWidth.
    const physicalW = original.sourceWidth ?? original.width;
    const physicalH = original.sourceHeight ?? original.height;

    let calculatedW: number;
    let calculatedH: number;
    
    if (stat.isOverridden) {
        // CASE A: User Override
        // The stat.maxRenderWidth already includes the override percentage calculation
        calculatedW = stat.maxRenderWidth;
        calculatedH = stat.maxRenderHeight;
    } else {
        // CASE B: Standard Optimization
        // Apply the safety buffer to the calculated max requirement (Canonical * MaxScale)
        const bufferMultiplier = 1 + (bufferPercentage / 100);
        calculatedW = Math.ceil(stat.maxRenderWidth * bufferMultiplier);
        calculatedH = Math.ceil(stat.maxRenderHeight * bufferMultiplier);
    }

    // Apply Final Cap: min(Calculated, Physical)
    // We never want to upscale the physical asset automatically or via override beyond its source quality.
    let targetW = Math.min(calculatedW, physicalW);
    let targetH = Math.min(calculatedH, physicalH);
    
    // Clamp to minimum 1x1 to prevent invalid images
    targetW = Math.max(1, targetW);
    targetH = Math.max(1, targetH);
    
    // Determine if resize is actually needed
    // We compare target against PHYSICAL dimensions.
    const isResize = targetW !== physicalW || targetH !== physicalH;
    
    // Determine Output Filename
    // Use the original relative path to preserve folder structure
    const sourcePath = original.originalPath;
    
    // Robustly strip existing extension
    // Check for last slash to ensure we don't strip dots from directory names
    const lastSlashIndex = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
    const lastDotIndex = sourcePath.lastIndexOf('.');
    
    let basePath = sourcePath;
    // Only strip extension if the dot is after the last slash (part of filename)
    if (lastDotIndex > lastSlashIndex) {
        basePath = sourcePath.substring(0, lastDotIndex);
    }
        
    // Append the mandatory .png extension
    const outputFileName = `${basePath}.png`;

    tasks.push({
      fileName: outputFileName,
      relativePath: original.originalPath,
      // Task should report the physical original size for the UI comparison
      originalWidth: physicalW,
      originalHeight: physicalH,
      targetWidth: targetW,
      targetHeight: targetH,
      blob: original.file,
      maxScaleUsed: Math.max(stat.maxScaleX, stat.maxScaleY),
      isResize: isResize,
      overridePercentage: stat.overridePercentage
    });
  });

  // Sort: Resized items first for better visibility in the modal
  tasks.sort((a, b) => (a.isResize === b.isResize ? 0 : a.isResize ? -1 : 1));

  return tasks;
}

export async function resizeImage(blob: Blob, width: number, height: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(width);
      canvas.height = Math.floor(height);
      const ctx = canvas.getContext('2d', { alpha: true });
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        canvas.toBlob((resultBlob) => {
          URL.revokeObjectURL(url);
          resolve(resultBlob);
        }, 'image/png');
      } else {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

export async function generateOptimizedZip(
  tasks: OptimizationTask[], 
  onProgress: (current: number, total: number) => void
): Promise<Blob> {
  const zip = new JSZip();
  // Bundle files in a root folder "images_optimized"
  const rootFolder = zip.folder("images_optimized");
  let completed = 0;

  for (const task of tasks) {
    if (!rootFolder) break;

    // Use the task's prepared filename directly
    // This now correctly includes path and standardized extension
    const zipEntryName = task.fileName;

    if (task.isResize) {
      const resizedBlob = await resizeImage(task.blob, task.targetWidth, task.targetHeight);
      if (resizedBlob) {
        rootFolder.file(zipEntryName, resizedBlob);
      } else {
        // Fallback to original if resize fails
        rootFolder.file(zipEntryName, task.blob);
      }
    } else {
      // Direct copy of in-memory blob
      rootFolder.file(zipEntryName, task.blob);
    }
    
    completed++;
    onProgress(completed, tasks.length);
  }

  return await zip.generateAsync({ type: "blob" });
}
